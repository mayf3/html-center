#!/usr/bin/env python3
"""Publish an HTML report or static directory to HTML Center."""

from __future__ import annotations

import argparse
import base64
import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path


DEFAULT_URL = os.environ.get("HTML_CENTER_URL", "http://127.0.0.1:4177")
IGNORED_DIRS = {".git", "node_modules", "__pycache__"}
IGNORED_FILES = {".DS_Store"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish HTML output to HTML Center.")
    parser.add_argument("path", help="HTML file or static site directory to upload")
    parser.add_argument("--title", default="", help="Display title")
    parser.add_argument("--category", default="design-review", help="Center category")
    parser.add_argument("--description", default="", help="Optional description")
    parser.add_argument("--source", default="", help="Reviewed target or source path")
    parser.add_argument("--entry", default="", help="Entry path inside the uploaded bundle")
    parser.add_argument("--tags", default="", help="Comma-separated tags")
    parser.add_argument("--url", default=DEFAULT_URL, help="HTML Center base URL")
    args = parser.parse_args()

    input_path = Path(args.path).expanduser().resolve()
    if not input_path.exists():
        raise SystemExit(f"Path does not exist: {input_path}")

    files = collect_files(input_path)
    if not files:
        raise SystemExit(f"No uploadable files found in {input_path}")

    entry = choose_entry(args.entry, files)
    title = args.title or read_title(files, entry) or input_path.name
    payload = {
        "title": title,
        "category": args.category,
        "description": args.description,
        "source": args.source or str(input_path),
        "entry": entry,
        "tags": [tag.strip() for tag in args.tags.split(",") if tag.strip()],
        "files": [
            {
                "path": relative_path,
                "encoding": "base64",
                "content": base64.b64encode(absolute_path.read_bytes()).decode("ascii"),
            }
            for relative_path, absolute_path in files
        ],
    }

    endpoint = args.url.rstrip("/") + "/api/sites"
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Upload failed: HTTP {exc.code} {detail}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Upload failed: {exc.reason}") from exc

    print(f"Uploaded: {result['site']['title']}")
    print(f"ID: {result['id']}")
    print(f"Open: {result['url']}")
    print(f"Entry: {result['entryUrl']}")
    return 0


def collect_files(input_path: Path) -> list[tuple[str, Path]]:
    if input_path.is_file():
        return [(input_path.name, input_path)]

    files: list[tuple[str, Path]] = []
    for absolute_path in sorted(input_path.rglob("*")):
        relative = absolute_path.relative_to(input_path)
        if any(part in IGNORED_DIRS for part in relative.parts):
            continue
        if absolute_path.name in IGNORED_FILES:
            continue
        if absolute_path.is_file():
            files.append((relative.as_posix(), absolute_path))
    return files


def choose_entry(entry: str, files: list[tuple[str, Path]]) -> str:
    paths = [relative_path for relative_path, _ in files]
    if entry:
        normalized = Path(entry).as_posix()
        if normalized not in paths:
            raise SystemExit(f"Entry file is not in upload set: {normalized}")
        return normalized
    for candidate in paths:
        if candidate.lower() == "index.html":
            return candidate
    for candidate in paths:
        if candidate.lower().endswith((".html", ".htm")):
            return candidate
    return paths[0]


def read_title(files: list[tuple[str, Path]], entry: str) -> str:
    if not entry.lower().endswith((".html", ".htm")):
        return ""
    for relative_path, absolute_path in files:
        if relative_path != entry:
            continue
        text = absolute_path.read_text("utf-8", errors="ignore")
        match = re.search(r"<title[^>]*>(.*?)</title>", text, re.IGNORECASE | re.DOTALL)
        if not match:
            return ""
        return html.unescape(re.sub(r"\s+", " ", match.group(1)).strip())
    return ""


if __name__ == "__main__":
    sys.exit(main())
