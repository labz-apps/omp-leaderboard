/**
 * HTML helpers and formatting.
 *
 * Everything is escaped at the boundary: result files are untrusted input as
 * far as the renderer is concerned, because they arrive from a harness run on
 * some other machine.
 */

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a value for interpolation into HTML text or a double-quoted attribute. */
export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * Only same-document, relative-safe URLs are allowed through as href/src.
 * Anything absolute (http, protocol-relative, or root-relative) is rejected so
 * a malformed result file cannot inject an off-site link into the site.
 *
 * @param {unknown} url
 */
export function safeHref(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    // Absolute URLs are allowed only for the merged PR link, and only https.
    return trimmed.startsWith("https://") ? trimmed : null;
  }
  return trimmed;
}

/** Format a millisecond value for humans. */
export function fmtMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value >= 10000) return `${(value / 1000).toFixed(1)} s`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (value >= 100) return `${Math.round(value)} ms`;
  return `${value.toFixed(1)} ms`;
}

/** Format a percent delta, or an em dash when there is no baseline. */
export function fmtPct(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

/** Format an absolute millisecond delta, keeping the sign visible. */
export function fmtDeltaMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return `${sign}${fmtMs(Math.abs(value))}`;
}

export function fmtDate(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  return new Date(time).toISOString().slice(0, 10);
}

export function fmtDateTime(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  return `${fmtDate(iso)} ${new Date(time).toISOString().slice(11, 16)} UTC`;
}

/** Join class names, dropping falsy entries. */
export function cx(...names) {
  return names.filter(Boolean).join(" ");
}

/**
 * Direction of a latency delta.
 * @param {number | null} pct negative is better, since these are latencies
 */
export function deltaDirection(pct) {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return "none";
  if (Math.abs(pct) < 0.5) return "flat";
  return pct < 0 ? "better" : "worse";
}
