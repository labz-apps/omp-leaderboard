import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const workflowsDir = join(repoRoot, ".github", "workflows");

async function workflow(name) {
  return readFile(join(workflowsDir, name), "utf8");
}

async function allWorkflows() {
  const names = (await readdir(workflowsDir)).filter((name) => name.endsWith(".yml"));
  const entries = await Promise.all(names.map(async (name) => [name, await workflow(name)]));
  return entries;
}

test("every workflow declares on, permissions, and jobs", async () => {
  for (const [name, text] of await allWorkflows()) {
    assert.match(text, /^on:/m, `${name} has no top-level on:`);
    assert.match(text, /^permissions:/m, `${name} has no top-level permissions:`);
    assert.match(text, /^jobs:/m, `${name} has no top-level jobs:`);
    // Least privilege is the default expectation: an undeclared permission is
    // how a build workflow ends up able to rewrite history.
    const tokenPermissions = text.match(/^\s{2}[a-z-]+:\s*(read|write|none)\s*$/gm) ?? [];
    for (const line of tokenPermissions) {
      assert.match(line, /read|write|none/, `${name}: unfree permission line "${line.trim()}"`);
    }
  }
});

test("pages.yml wires verify -> build -> upload -> deploy", async () => {
  const text = await workflow("pages.yml");
  assert.match(text, /actions\/configure-pages@v\d+/, "no base path resolution");
  assert.match(text, /BASE_PATH: \$\{\{ steps\.pages\.outputs\.base_path \}\}/, "the build does not use the resolved base path");
  assert.match(text, /node src\/build\.mjs --base "\$BASE_PATH"/, "the build ignores the base path");
  assert.match(text, /actions\/upload-pages-artifact@v\d+/, "nothing is uploaded");
  assert.match(text, /actions\/deploy-pages@v\d+/, "nothing is deployed");
  assert.match(text, /^\s+pages: write$/m, "Pages deploy needs pages: write");
  assert.match(text, /^\s+id-token: write$/m, "Pages deploy needs id-token: write");
  assert.match(text, /concurrency:/, "no concurrency guard on the deploy");
  assert.match(text, /environment:\s*\n\s+name: github-pages/, "deploy is not bound to the github-pages environment");
});

test("gh-pages.yml publishes the branch and is manual only", async () => {
  const text = await workflow("gh-pages.yml");
  assert.match(text, /on:\s*\n\s+workflow_dispatch:/, "gh-pages must not auto-publish alongside pages.yml");
  assert.match(text, /^\s+contents: write$/m, "pushing a branch needs contents: write");
  assert.match(text, /node src\/deploy-gh-pages\.mjs/, "the branch publish script is not called");
  assert.match(text, /npm run verify/, "the branch path publishes without verifying");
  assert.ok(!text.includes("branches: [main]"), "gh-pages must not trigger on pushes to main");
});

test("only one workflow publishes automatically on a push to main", async () => {
  // Two publish paths exist on purpose (Actions artifact and gh-pages branch),
  // but only one may fire automatically, or it would be ambiguous which build
  // Pages is actually serving.
  const publishes = /actions\/upload-pages-artifact@|actions\/deploy-pages@|src\/deploy-gh-pages\.mjs/;
  const autoPublishes = [];
  for (const [name, text] of await allWorkflows()) {
    const code = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    if (/branches:\s*\[main\]/.test(code) && publishes.test(code)) {
      autoPublishes.push(name);
    }
  }
  assert.deepEqual(autoPublishes, ["pages.yml"], `more than one workflow auto-publishes: ${autoPublishes.join(", ")}`);
});

test("validate.yml gates pull requests with the same verification", async () => {
  const text = await workflow("validate.yml");
  assert.match(text, /pull_request:/);
  assert.match(text, /branches: \[main\]/);
  assert.match(text, /npm run verify/);
  assert.match(text, /build output must not be committed/, "no guard against committing dist/");
});

test("record-result.yml is manual, measures in CI, and cannot fail a normal push", async () => {
  const text = await workflow("record-result.yml");
  assert.match(text, /workflow_dispatch:/);
  assert.ok(!text.includes("branches: [main]"), "record-result must not run on pushes");
  assert.match(text, /scripts\/bench\/\$\{\{ inputs\.benchmark \}\}\.ts/, "no harness invocation");
  assert.match(text, /npm run import-result/, "harness output is not piped through the importer");
  assert.match(text, /add-paths: data\/results/, "a result file outside data/results would be ignored by the build");
  assert.match(text, /does not exist in/, "no explicit failure when the harness is missing");
});

test("no workflow installs dependencies", async () => {
  for (const [name, text] of await allWorkflows()) {
    assert.ok(!/\bnpm (ci|install|i)\b/.test(text), `${name} installs dependencies; the site has none, so this can only fail`);
    assert.ok(!/\bbun install\b/.test(text), `${name} installs dependencies`);
    assert.ok(!/\byarn (install|add)\b/.test(text), `${name} installs dependencies`);
  }
});

test("every script a workflow calls actually exists", async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const scripts = new Set(Object.keys(packageJson.scripts ?? {}));

  for (const [name, text] of await allWorkflows()) {
    for (const match of text.matchAll(/\bnode\s+([\w./-]+\.mjs)/g)) {
      const relative = match[1];
      assert.ok(
        await readFile(join(repoRoot, relative), "utf8").catch(() => null) !== null,
        `${name} calls node ${relative}, which does not exist`,
      );
    }
    for (const match of text.matchAll(/\bnpm run ([\w:-]+)/g)) {
      assert.ok(scripts.has(match[1]), `${name} calls "npm run ${match[1]}", which is not a script in package.json`);
    }
  }
});

test("every script the tests import exists", async () => {
  const testDir = join(repoRoot, "test");
  for (const name of await readdir(testDir)) {
    if (!name.endsWith(".test.mjs")) continue;
    const text = await readFile(join(testDir, name), "utf8");
    for (const match of text.matchAll(/from "\.\.\/([^"]+)"/g)) {
      const imported = await readFile(join(repoRoot, match[1]), "utf8").catch(() => null);
      assert.ok(imported !== null, `test/${name} imports ../${match[1]}, which does not exist`);
    }
  }
});

test("the deploy script is reachable as a command too", async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  assert.match(packageJson.scripts["deploy:gh-pages"], /src\/deploy-gh-pages\.mjs/);
});