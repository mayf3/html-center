#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_URL = process.env.HTML_CENTER_URL || "http://127.0.0.1:4177";
const IGNORED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build"]);
const IGNORED_FILES = new Set([".DS_Store"]);

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.path) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  const inputPath = path.resolve(args.path);
  const stat = await fs.stat(inputPath);
  const files = stat.isDirectory()
    ? await collectDirectory(inputPath)
    : [{ absolutePath: inputPath, relativePath: path.basename(inputPath) }];

  if (!files.length) {
    throw new Error(`No uploadable files found in ${inputPath}`);
  }

  const entry = chooseEntry(args.entry, files);
  const title = args.title || await readTitle(inputPath, entry, files) || path.basename(inputPath);
  const payload = {
    title,
    category: args.category || "design-review",
    description: args.description || "",
    source: args.source || inputPath,
    entry,
    tags: args.tags ? args.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
    files: await Promise.all(files.map(async (file) => ({
      path: toPosix(file.relativePath),
      encoding: "base64",
      content: await fs.readFile(file.absolutePath, "base64"),
    }))),
  };

  const targetUrl = new URL("/api/sites", args.url || DEFAULT_URL);
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`Upload failed with HTTP ${response.status}: ${text}`);
  }
  if (!response.ok) {
    throw new Error(`Upload failed with HTTP ${response.status}: ${result.message || result.error || text}`);
  }

  console.log(`Uploaded: ${result.site.title}`);
  console.log(`ID: ${result.id}`);
  console.log(`Open: ${result.url}`);
  console.log(`Entry: ${result.entryUrl}`);
}

function parseArgs(argv) {
  const parsed = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        parsed[key] = "true";
      } else {
        parsed[key] = next;
        index += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  parsed.path = positional[0];
  return parsed;
}

function printUsage() {
  console.log(`Usage:
  npm run upload -- <file-or-directory> [options]

Options:
  --title <text>          Display title
  --category <text>       Category shown on the index page (default: design-review)
  --description <text>    Optional description
  --source <text>         Optional source path or URL
  --entry <path>          Entry HTML path inside the uploaded bundle
  --tags <a,b,c>          Comma-separated tags
  --url <url>             HTML Center base URL (default: ${DEFAULT_URL})
`);
}

async function collectDirectory(root) {
  const files = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      if (entry.isFile() && IGNORED_FILES.has(entry.name)) continue;

      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        files.push({
          absolutePath,
          relativePath: path.relative(root, absolutePath),
        });
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function chooseEntry(entry, files) {
  const paths = files.map((file) => toPosix(file.relativePath));
  if (entry) {
    const normalized = toPosix(entry);
    if (!paths.includes(normalized)) {
      throw new Error(`Entry file is not in upload set: ${normalized}`);
    }
    return normalized;
  }
  return paths.find((filePath) => filePath.toLowerCase() === "index.html")
    || paths.find((filePath) => /\.html?$/i.test(filePath))
    || paths[0];
}

async function readTitle(inputPath, entry, files) {
  if (!/\.html?$/i.test(entry)) return "";
  const file = files.find((item) => toPosix(item.relativePath) === entry);
  if (!file) return "";
  const content = await fs.readFile(file.absolutePath, "utf8");
  const match = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities(match[1].replace(/\s+/g, " ").trim()) : "";
}

function decodeHtmlEntities(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function toPosix(value) {
  return String(value).replaceAll(path.sep, "/").replaceAll("\\", "/");
}
