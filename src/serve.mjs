#!/usr/bin/env node
/**
 * A deliberately dumb static file server that mimics the parts of GitHub Pages
 * this site depends on:
 *
 *   - it serves only from `dist/`
 *   - it serves `index.html` for a directory path
 *   - it 404s to `404.html` for anything unknown
 *   - it serves under a base path, so we can prove the build works when hosted
 *     at `https://<owner>.github.io/<repo>/`
 *
 * Used by `npm run serve` and by `npm run verify`.
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * @param {object} options
 * @param {string} options.root directory to serve
 * @param {string} [options.basePath] e.g. "/omp-leaderboard/"
 * @returns {Promise<{url: string, close: () => Promise<void>, port: number}>}
 */
export async function startStaticServer({ root, basePath = "/", host = "127.0.0.1", port = 0 }) {
  const rootResolved = resolve(root);
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let pathname = decodeURIComponent(url.pathname);

      if (!pathname.startsWith(base)) {
        return sendNotFound(res, rootResolved);
      }
      pathname = pathname.slice(base.length - 1); // keep the leading slash

      if (pathname.endsWith("/")) pathname += "index.html";

      // Contain path traversal: the resolved path must stay inside root.
      const candidate = resolve(join(rootResolved, normalize(pathname)));
      if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
        return sendNotFound(res, rootResolved);
      }

      let info = await stat(candidate).catch(() => null);
      if (info?.isDirectory()) {
        return redirectOrIndex(res, candidate, url, base);
      }
      if (!info) {
        // GitHub Pages does not do extensionless lookup; keep the same
        // behaviour so local verification does not pass on magic the host lacks.
        return sendNotFound(res, rootResolved);
      }

      res.writeHead(200, {
        "content-type": MIME[extname(candidate)] ?? "application/octet-stream",
        "content-length": info.size,
        "cache-control": "no-store",
      });
      createReadStream(candidate).pipe(res);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`500 ${error.message}`);
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `http://${host}:${actualPort}${base}`,
    port: actualPort,
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose(undefined));
      }),
  };
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} root
 */
async function sendNotFound(res, root) {
  const notFound = join(root, "404.html");
  const info = await stat(notFound).catch(() => null);
  if (!info) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404");
    return;
  }
  res.writeHead(404, { "content-type": MIME[".html"] });
  createReadStream(notFound).pipe(res);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} dir
 * @param {URL} url
 * @param {string} base
 */
function redirectOrIndex(res, dir, url, base) {
  const index = join(dir, "index.html");
  stat(index)
    .then((info) => {
      res.writeHead(200, { "content-type": MIME[".html"], "content-length": info.size });
      createReadStream(index).pipe(res);
    })
    .catch(() => {
      res.writeHead(301, { location: `${url.pathname.replace(/\/?$/, "/")}` });
      res.end();
    });
  void base;
}

const isMain = process.argv[1]?.endsWith("serve.mjs");

if (isMain) {
  const outIndex = process.argv.indexOf("--out");
  const baseIndex = process.argv.indexOf("--base");
  const portIndex = process.argv.indexOf("--port");
  const root = outIndex !== -1 ? process.argv[outIndex + 1] : "dist";
  const basePath = baseIndex !== -1 ? process.argv[baseIndex + 1] : "/";
  const port = portIndex !== -1 ? Number(process.argv[portIndex + 1]) : 4321;

  const handle = await startStaticServer({ root, basePath, port });
  process.stdout.write(`serving ${resolve(root)} at ${handle.url}\n`);
}
