#!/usr/bin/env python3
"""Ensure the local HTML Center service is reachable."""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


DEFAULT_URL = os.environ.get("HTML_CENTER_URL", "http://127.0.0.1:4177")
DEFAULT_PROJECT = os.environ.get(
    "HTML_CENTER_PROJECT",
    "/home/user/projects/html-center",
)
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Ensure HTML Center is running.")
    parser.add_argument("--url", default=DEFAULT_URL, help="HTML Center base URL")
    parser.add_argument("--project", default=DEFAULT_PROJECT, help="html-center project path")
    parser.add_argument(
        "--session",
        default=os.environ.get("HTML_CENTER_TMUX_SESSION", "html-center"),
        help="tmux session name",
    )
    parser.add_argument("--timeout", type=float, default=10.0, help="Seconds to wait")
    parser.add_argument("--no-start", action="store_true", help="Only check health")
    args = parser.parse_args()

    url = args.url.rstrip("/")
    if is_healthy(url):
        print(f"HTML Center ready: {url}")
        return 0

    if args.no_start:
        print(f"HTML Center is not reachable: {url}", file=sys.stderr)
        return 1

    parsed = urllib.parse.urlparse(url)
    if parsed.hostname not in LOCAL_HOSTS:
        print(f"HTML Center is not local, cannot auto-start: {url}", file=sys.stderr)
        return 1

    project = Path(args.project).expanduser().resolve()
    if not (project / "package.json").exists():
        print(f"html-center project not found: {project}", file=sys.stderr)
        print("Set HTML_CENTER_PROJECT to the html-center project path.", file=sys.stderr)
        return 1

    started = start_service(project, parsed, args.session)
    if not started:
        return 1

    deadline = time.time() + args.timeout
    while time.time() < deadline:
        if is_healthy(url):
            print(f"HTML Center ready: {url}")
            return 0
        time.sleep(0.25)

    print(f"HTML Center did not become healthy within {args.timeout:.1f}s: {url}", file=sys.stderr)
    print(f"Inspect logs: tmux capture-pane -t {shlex.quote(args.session)} -p -S -120", file=sys.stderr)
    return 1


def is_healthy(base_url: str) -> bool:
    request = urllib.request.Request(base_url.rstrip("/") + "/api/health", method="GET")
    try:
        with urllib.request.urlopen(request, timeout=1.5) as response:
            return 200 <= response.status < 300
    except (OSError, urllib.error.URLError):
        return False


def start_service(project: Path, parsed_url: urllib.parse.ParseResult, session: str) -> bool:
    env_exports = []
    if parsed_url.port:
        env_exports.append(f"PORT={shlex.quote(str(parsed_url.port))}")
    if parsed_url.hostname in LOCAL_HOSTS:
        env_exports.append("HOST=127.0.0.1")

    npm_command = " ".join([*env_exports, "npm", "start"])
    command = f"cd {shlex.quote(str(project))} && {npm_command}"

    tmux = shutil.which("tmux")
    if tmux:
        existing = subprocess.run(
            [tmux, "has-session", "-t", session],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if existing.returncode == 0:
            print(f"tmux session already exists: {session}")
            return True

        result = subprocess.run(
            [tmux, "new-session", "-d", "-s", session, command],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            print(result.stderr.strip() or "Failed to start tmux session.", file=sys.stderr)
            return False
        print(f"Started HTML Center in tmux session: {session}")
        return True

    log_path = project / "html-center.log"
    log_file = log_path.open("ab")
    subprocess.Popen(
        ["npm", "start"],
        cwd=project,
        env={**os.environ, **env_from_url(parsed_url)},
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    print(f"Started HTML Center in background; log: {log_path}")
    return True


def env_from_url(parsed_url: urllib.parse.ParseResult) -> dict[str, str]:
    env: dict[str, str] = {}
    if parsed_url.port:
        env["PORT"] = str(parsed_url.port)
    if parsed_url.hostname in LOCAL_HOSTS:
        env["HOST"] = "127.0.0.1"
    return env


if __name__ == "__main__":
    sys.exit(main())
