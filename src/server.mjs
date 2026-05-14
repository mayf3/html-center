import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "4177", 10);
const DATA_DIR = path.resolve(process.env.HTML_CENTER_DATA_DIR || path.join(ROOT, "data"));
const SITES_DIR = path.join(DATA_DIR, "sites");
const REGISTRY_PATH = path.join(DATA_DIR, "registry.json");
const MAX_BODY_BYTES = Number.parseInt(process.env.HTML_CENTER_MAX_MB || "250", 10) * 1024 * 1024;

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

let registryQueue = Promise.resolve();

await ensureStorage();

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error(error);
    const status = Number.isInteger(error.status) ? error.status : 500;
    sendJson(res, status, {
      error: error.code || "internal_error",
      message: error.message || "Internal server error.",
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`HTML Center listening on http://${HOST}:${PORT}`);
});

async function route(req, res) {
  const baseUrl = `http://${req.headers.host || `${HOST}:${PORT}`}`;
  const url = new URL(req.url || "/", baseUrl);

  if (req.method === "GET" && url.pathname === "/") {
    const registry = await loadRegistry();
    return sendHtml(res, renderIndex(registry.sites || []));
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, service: "html-center" });
  }

  if (req.method === "GET" && url.pathname === "/api/sites") {
    const registry = await loadRegistry();
    return sendJson(res, 200, { sites: registry.sites || [] });
  }

  if (req.method === "POST" && url.pathname === "/api/sites") {
    const payload = await readJsonBody(req);
    const site = await createSite(payload, baseUrl);
    return sendJson(res, 201, site);
  }

  const openMatch = url.pathname.match(/^\/open\/([^/]+)$/);
  if (req.method === "GET" && openMatch) {
    const site = await getSite(openMatch[1]);
    if (!site) return sendNotFound(res);
    return redirect(res, `/view/${encodeURIComponent(site.id)}/${encodePath(site.entry)}`);
  }

  const apiSiteMatch = url.pathname.match(/^\/api\/sites\/([^/]+)$/);
  if (req.method === "GET" && apiSiteMatch) {
    const site = await getSite(apiSiteMatch[1]);
    if (!site) return sendNotFound(res);
    return sendJson(res, 200, { site });
  }

  const viewMatch = url.pathname.match(/^\/view\/([^/]+)(?:\/(.*))?$/);
  if ((req.method === "GET" || req.method === "HEAD") && viewMatch) {
    return serveSiteFile(res, viewMatch[1], viewMatch[2] || "", req.method === "HEAD");
  }

  return sendNotFound(res);
}

async function ensureStorage() {
  await fs.mkdir(SITES_DIR, { recursive: true });
  try {
    await fs.access(REGISTRY_PATH);
  } catch {
    await writeJsonAtomic(REGISTRY_PATH, { sites: [] });
  }
}

async function loadRegistry() {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, "utf8");
    const registry = JSON.parse(raw);
    return { sites: Array.isArray(registry.sites) ? registry.sites : [] };
  } catch {
    return { sites: [] };
  }
}

async function saveRegistry(registry) {
  const sites = [...(registry.sites || [])].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  await writeJsonAtomic(REGISTRY_PATH, { sites });
}

async function updateRegistry(mutator) {
  const next = registryQueue.then(async () => {
    const registry = await loadRegistry();
    const updated = await mutator(registry);
    await saveRegistry(updated || registry);
  });
  registryQueue = next.catch(() => {});
  return next;
}

async function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function getSite(id) {
  const registry = await loadRegistry();
  return (registry.sites || []).find((site) => site.id === id) || null;
}

async function createSite(payload, baseUrl) {
  if (!payload || typeof payload !== "object") {
    throw httpError(400, "invalid_payload", "Expected a JSON object.");
  }

  const files = normalizeFiles(payload);
  if (!files.length) {
    throw httpError(400, "missing_files", "Provide at least one file or an html field.");
  }

  const title = cleanText(payload.title, "Untitled HTML");
  const category = cleanText(payload.category, "uncategorized");
  const description = cleanOptionalText(payload.description);
  const source = cleanOptionalText(payload.source);
  const tags = normalizeTags(payload.tags);
  const fileMap = new Map();
  let totalBytes = 0;

  for (const file of files) {
    const safePath = sanitizeRelativePath(file.path);
    const bytes = decodeFileContent(file);
    if (fileMap.has(safePath)) {
      throw httpError(400, "duplicate_file", `Duplicate file path: ${safePath}`);
    }
    fileMap.set(safePath, bytes);
    totalBytes += bytes.byteLength;
  }

  const filePaths = [...fileMap.keys()];
  const entry = chooseEntry(payload.entry, filePaths);
  const htmlFiles = filePaths.filter((filePath) => /\.html?$/i.test(filePath)).sort();
  const uploadedAt = new Date().toISOString();
  const id = await makeSiteId(title, uploadedAt);
  const siteDir = path.join(SITES_DIR, id);

  await fs.mkdir(siteDir, { recursive: false });
  try {
    for (const [relativePath, bytes] of fileMap.entries()) {
      const target = resolveInside(siteDir, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }

    const site = {
      id,
      title,
      category,
      description,
      source,
      tags,
      entry,
      uploadedAt,
      fileCount: filePaths.length,
      totalBytes,
      htmlFiles,
    };

    await writeJsonAtomic(path.join(siteDir, "manifest.json"), site);
    await updateRegistry((registry) => {
      registry.sites = [site, ...(registry.sites || []).filter((item) => item.id !== id)];
      return registry;
    });

    return {
      id,
      url: `${baseUrl}/open/${encodeURIComponent(id)}`,
      entryUrl: `${baseUrl}/view/${encodeURIComponent(id)}/${encodePath(entry)}`,
      site,
    };
  } catch (error) {
    await fs.rm(siteDir, { recursive: true, force: true });
    throw error;
  }
}

function normalizeFiles(payload) {
  if (typeof payload.html === "string" && !Array.isArray(payload.files)) {
    return [
      {
        path: payload.entry || "index.html",
        encoding: "utf8",
        content: payload.html,
      },
    ];
  }
  if (!Array.isArray(payload.files)) return [];
  if (payload.files.length > 5000) {
    throw httpError(400, "too_many_files", "A single upload can include at most 5000 files.");
  }
  return payload.files;
}

function decodeFileContent(file) {
  if (!file || typeof file !== "object") {
    throw httpError(400, "invalid_file", "Each file must be an object.");
  }
  const encoding = file.encoding || (typeof file.contentBase64 === "string" ? "base64" : "utf8");
  const content = typeof file.contentBase64 === "string" ? file.contentBase64 : file.content;

  if (typeof content !== "string") {
    throw httpError(400, "invalid_file_content", `Missing content for file: ${file.path || "(unknown)"}`);
  }
  if (encoding === "base64") {
    return Buffer.from(content, "base64");
  }
  if (encoding === "utf8" || encoding === "text") {
    return Buffer.from(content, "utf8");
  }
  throw httpError(400, "unsupported_encoding", `Unsupported encoding: ${encoding}`);
}

function chooseEntry(entryInput, filePaths) {
  if (entryInput) {
    const entry = sanitizeRelativePath(String(entryInput));
    if (!filePaths.includes(entry)) {
      throw httpError(400, "entry_not_found", `Entry file is not included in upload: ${entry}`);
    }
    return entry;
  }
  const index = filePaths.find((filePath) => filePath.toLowerCase() === "index.html");
  if (index) return index;
  const firstHtml = filePaths.find((filePath) => /\.html?$/i.test(filePath));
  return firstHtml || filePaths[0];
}

async function makeSiteId(title, uploadedAt) {
  const stamp = uploadedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-").replace("Z", "");
  const slug = slugify(title) || "site";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = randomBytes(4).toString("hex");
    const id = `${stamp}-${slug}-${suffix}`.slice(0, 120);
    try {
      await fs.access(path.join(SITES_DIR, id));
    } catch {
      return id;
    }
  }
  return `${stamp}-site-${createHash("sha1").update(`${title}:${Math.random()}`).digest("hex").slice(0, 8)}`;
}

function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function sanitizeRelativePath(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw httpError(400, "invalid_path", "File path cannot be empty.");
  }
  const normalizedInput = input.replace(/\\/g, "/");
  if (normalizedInput.includes("\0") || normalizedInput.startsWith("/") || /^[a-zA-Z]:/.test(normalizedInput)) {
    throw httpError(400, "invalid_path", `Unsafe path: ${input}`);
  }
  const normalized = path.posix.normalize(normalizedInput);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw httpError(400, "invalid_path", `Unsafe path: ${input}`);
  }
  return normalized;
}

function resolveInside(root, relativePath) {
  const target = path.resolve(root, relativePath);
  const rootWithSep = `${path.resolve(root)}${path.sep}`;
  if (target !== path.resolve(root) && !target.startsWith(rootWithSep)) {
    throw httpError(400, "invalid_path", `Unsafe path: ${relativePath}`);
  }
  return target;
}

async function serveSiteFile(res, siteId, rawPath, headOnly = false) {
  const site = await getSite(siteId);
  if (!site) return sendNotFound(res);
  if (!rawPath) return redirect(res, `/view/${encodeURIComponent(site.id)}/${encodePath(site.entry)}`);

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    throw httpError(400, "invalid_path", "Path is not valid URI encoding.");
  }

  const relativePath = sanitizeRelativePath(decodedPath);
  let target = resolveInside(path.join(SITES_DIR, site.id), relativePath);
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return sendNotFound(res);
  }

  if (stat.isDirectory()) {
    target = path.join(target, "index.html");
    try {
      stat = await fs.stat(target);
    } catch {
      return sendNotFound(res);
    }
  }
  if (!stat.isFile()) return sendNotFound(res);

  const contentType = MIME_TYPES.get(path.extname(target).toLowerCase()) || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": "no-store",
  });
  if (headOnly) {
    res.end();
    return;
  }
  const body = await fs.readFile(target);
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw httpError(413, "payload_too_large", `Upload exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw httpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function cleanText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, 200) : fallback;
}

function cleanOptionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1000) : "";
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 20);
  }
  return [];
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(data, null, 2)}\n`);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendNotFound(res) {
  sendJson(res, 404, { error: "not_found" });
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function encodePath(relativePath) {
  return relativePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function renderIndex(sites) {
  const categories = [...new Set(sites.map((site) => site.category).filter(Boolean))].sort();
  const totalFiles = sites.reduce((sum, site) => sum + Number(site.fileCount || 0), 0);
  const rows = sites.map(renderSiteRow).join("");
  const categoryOptions = categories
    .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HTML Center</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #15181e;
      --muted: #657184;
      --line: #d9dee8;
      --accent: #126e82;
      --accent-2: #6b4fa3;
      --danger: #9b2f2f;
      --shadow: 0 12px 40px rgba(25, 34, 48, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: var(--bg);
    }
    a { color: inherit; }
    .topbar {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
      padding: 28px clamp(18px, 4vw, 44px) 20px;
      border-bottom: 1px solid var(--line);
      background: #fff;
    }
    .eyebrow {
      margin: 0 0 2px;
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: clamp(28px, 4vw, 44px);
      line-height: 1;
      letter-spacing: 0;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(80px, 1fr));
      gap: 10px;
      min-width: min(420px, 100%);
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      background: #fbfcfe;
    }
    .metric strong {
      display: block;
      font-size: 20px;
      line-height: 1.1;
    }
    .metric span {
      color: var(--muted);
      font-size: 12px;
    }
    .shell {
      width: min(1180px, calc(100% - 32px));
      margin: 24px auto 48px;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 220px auto;
      gap: 12px;
      align-items: center;
      margin-bottom: 16px;
    }
    input, select {
      width: 100%;
      height: 42px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 12px;
      background: #fff;
      color: var(--text);
      font: inherit;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 42px;
      padding: 0 14px;
      border: 1px solid var(--accent);
      border-radius: 8px;
      color: #fff;
      background: var(--accent);
      text-decoration: none;
      font-weight: 700;
      white-space: nowrap;
    }
    .site-list {
      display: grid;
      gap: 10px;
    }
    .site-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: center;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .site-main {
      min-width: 0;
    }
    .site-title {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 8px;
      font-size: 18px;
      line-height: 1.25;
    }
    .site-title a {
      color: var(--text);
      text-decoration: none;
    }
    .site-title a:hover {
      color: var(--accent);
      text-decoration: underline;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 3px 8px;
      border-radius: 999px;
      color: #fff;
      background: var(--accent-2);
      font-size: 12px;
      font-weight: 700;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      margin: 0;
      color: var(--muted);
      font-size: 13px;
    }
    .description {
      margin: 8px 0 0;
      color: #384151;
    }
    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .secondary {
      border-color: var(--line);
      color: var(--text);
      background: #fff;
    }
    .empty {
      padding: 34px;
      border: 1px dashed #b8c1d0;
      border-radius: 8px;
      background: #fff;
      color: var(--muted);
      text-align: center;
    }
    .api-panel {
      margin-top: 28px;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .api-panel h2 {
      margin: 0 0 10px;
      font-size: 18px;
    }
    pre {
      margin: 12px 0 0;
      overflow-x: auto;
      border-radius: 8px;
      padding: 14px;
      background: #111827;
      color: #e5edf8;
      font-size: 13px;
    }
    .hidden { display: none; }
    @media (max-width: 760px) {
      .topbar {
        display: block;
      }
      .summary {
        margin-top: 18px;
      }
      .toolbar {
        grid-template-columns: 1fr;
      }
      .site-row {
        grid-template-columns: 1fr;
      }
      .actions {
        justify-content: flex-start;
        flex-wrap: wrap;
      }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div>
      <p class="eyebrow">Local registry</p>
      <h1>HTML Center</h1>
    </div>
    <div class="summary" aria-label="Registry summary">
      <div class="metric"><strong>${sites.length}</strong><span>Sites</span></div>
      <div class="metric"><strong>${categories.length}</strong><span>Categories</span></div>
      <div class="metric"><strong>${totalFiles}</strong><span>Files</span></div>
    </div>
  </header>
  <main class="shell">
    <div class="toolbar">
      <input id="search" type="search" placeholder="Search title, category, source, or description" autocomplete="off">
      <select id="category">
        <option value="">All categories</option>
        ${categoryOptions}
      </select>
      <a class="button secondary" href="#api">API contract</a>
    </div>
    <section class="site-list" id="site-list" aria-label="Uploaded HTML sites">
      ${rows || `<div class="empty">No uploads yet. Start the service, then run <code>npm run upload -- ./design-review.html --category design-review</code>.</div>`}
    </section>
    <section class="api-panel" id="api">
      <h2>Upload API</h2>
      <p>Send one HTML file or a nested static site as base64 encoded files.</p>
      <pre><code>POST /api/sites
{
  "title": "Design review",
  "category": "design-review",
  "entry": "index.html",
  "files": [
    { "path": "index.html", "encoding": "base64", "content": "..." },
    { "path": "assets/app.css", "encoding": "base64", "content": "..." }
  ]
}</code></pre>
    </section>
  </main>
  <script>
    const search = document.querySelector("#search");
    const category = document.querySelector("#category");
    const rows = [...document.querySelectorAll(".site-row")];

    function filterRows() {
      const query = search.value.trim().toLowerCase();
      const selected = category.value;
      for (const row of rows) {
        const matchesQuery = !query || row.dataset.search.includes(query);
        const matchesCategory = !selected || row.dataset.category === selected;
        row.classList.toggle("hidden", !(matchesQuery && matchesCategory));
      }
    }

    search.addEventListener("input", filterRows);
    category.addEventListener("change", filterRows);
  </script>
</body>
</html>`;
}

function renderSiteRow(site) {
  const href = `/open/${encodeURIComponent(site.id)}`;
  const detailsHref = `/api/sites/${encodeURIComponent(site.id)}`;
  const search = [
    site.title,
    site.category,
    site.description,
    site.source,
    site.entry,
    ...(site.tags || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return `<article class="site-row" data-category="${escapeHtml(site.category)}" data-search="${escapeHtml(search)}">
  <div class="site-main">
    <h2 class="site-title">
      <a href="${href}" target="_blank" rel="noopener">${escapeHtml(site.title)}</a>
      <span class="pill">${escapeHtml(site.category)}</span>
    </h2>
    <p class="meta">
      <span>Uploaded ${escapeHtml(formatDate(site.uploadedAt))}</span>
      <span>Entry ${escapeHtml(site.entry)}</span>
      <span>${Number(site.fileCount || 0)} files</span>
      <span>${escapeHtml(formatBytes(site.totalBytes || 0))}</span>
      ${site.source ? `<span>Source ${escapeHtml(site.source)}</span>` : ""}
    </p>
    ${site.description ? `<p class="description">${escapeHtml(site.description)}</p>` : ""}
  </div>
  <div class="actions">
    <a class="button" href="${href}" target="_blank" rel="noopener">Open</a>
    <a class="button secondary" href="${detailsHref}" target="_blank" rel="noopener">JSON</a>
  </div>
</article>`;
}
