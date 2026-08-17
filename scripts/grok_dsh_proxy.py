#!/usr/bin/env python3
"""Local OpenAI-compatible proxy that forwards DSH requests to Grok's
subscription-backed cli-chat-proxy.

Why this exists:
- DSH's pi-ai adapter talks to an OpenAI-compatible HTTP endpoint.
- Grok's subscription endpoint (`https://cli-chat-proxy.grok.com/v1`) needs a
  session token from `~/.grok/auth.json` plus special headers, including a
  per-model `x-grok-model-override` header.
- This proxy reads the `model` from the incoming OpenAI request, injects the
  required headers, and forwards through the machine's normal HTTP(S) proxy
  (e.g. http://127.0.0.1:7890) which the DSH Node process may not use itself.

Usage:
    python3 grok_dsh_proxy.py [--port 8765] [--grok-home ~/.grok]
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import requests
except Exception:  # pragma: no cover
    requests = None

CLI_CHAT_PROXY = "https://cli-chat-proxy.grok.com"
CLIENT_VERSION = "1.0.4"  # fallback; overwritten at startup when grok is found


def detect_client_version() -> str:
    """Return the installed grok CLI version (e.g. '1.0.4'), or a fallback."""
    exe = shutil.which("grok")
    if not exe:
        return CLIENT_VERSION
    try:
        out = subprocess.check_output([exe, "--version"], text=True, timeout=5, stderr=subprocess.STDOUT)
        match = re.search(r"(\d+\.\d+\.\d+)", out)
        if match:
            return match.group(1)
    except Exception:
        pass
    return CLIENT_VERSION


def read_token(grok_home: pathlib.Path) -> str:
    auth_file = grok_home / "auth.json"
    with open(auth_file, encoding="utf-8") as f:
        data = json.load(f)
    for value in data.values():
        if isinstance(value, dict) and value.get("key"):
            return str(value["key"])
    raise RuntimeError(f"no session token found in {auth_file}")


def make_headers(token: str, model: str | None) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {token}",
        "X-XAI-Token-Auth": "xai-grok-cli",
        "x-authenticateresponse": "authenticate-response",
        "x-grok-client-version": CLIENT_VERSION,
    }
    if model:
        headers["x-grok-model-override"] = model
    return headers


class GrokProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    grok_home: pathlib.Path = pathlib.Path.home() / ".grok"

    def log_message(self, fmt, *args):
        sys.stderr.write("[grok-dsh-proxy] %s\n" % (fmt % args))

    def _send_error_json(self, status: int, message: str) -> None:
        body = json.dumps({"error": {"message": message}}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _forward(self, method: str, body: bytes | None = None) -> None:
        if requests is None:
            self._send_error_json(500, "requests library is required for grok-dsh-proxy")
            return
        try:
            token = read_token(self.grok_home)
        except Exception as exc:
            self._send_error_json(502, f"cannot read Grok auth: {exc}")
            return
        model = None
        if body:
            try:
                model = json.loads(body.decode("utf-8")).get("model")
            except Exception:
                model = None
        headers = make_headers(token, model)
        headers["Content-Type"] = "application/json"
        url = CLI_CHAT_PROXY + self.path
        # Use the machine's normal HTTP(S) proxy (e.g. Clash on 127.0.0.1:7890).
        # verify=False is often required for local MITM-capable proxy certs.
        proxies = {
            "http": os.environ.get("http_proxy") or os.environ.get("HTTP_PROXY") or "http://127.0.0.1:7890",
            "https": os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY") or "http://127.0.0.1:7890",
        }
        try:
            upstream = requests.request(
                method,
                url,
                data=body,
                headers=headers,
                proxies=proxies,
                timeout=600,
                stream=True,
                verify=False,
            )
        except Exception as exc:
            self._send_error_json(502, f"upstream connection failed: {exc}")
            return

        if not upstream.ok:
            payload = upstream.content
            self.send_response(upstream.status_code)
            for key, value in upstream.headers.items():
                if key.lower() not in ("transfer-encoding", "connection", "content-length"):
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        self.send_response(upstream.status_code)
        for key, value in upstream.headers.items():
            if key.lower() not in ("transfer-encoding", "connection", "content-length"):
                self.send_header(key, value)
        # Without a Content-Length or chunked framing, HTTP/1.1 clients need
        # the connection close to know the stream ended.
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            for chunk in upstream.iter_content(chunk_size=8192):
                if chunk:
                    self.wfile.write(chunk)
                    self.wfile.flush()
        finally:
            upstream.close()

    def do_GET(self):
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            self._forward("GET")
        else:
            self._send_error_json(404, f"not found: {self.path}")

    def do_POST(self):
        if self.path.rstrip("/") in ("/v1/chat/completions", "/chat/completions"):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else None
            self._forward("POST", body)
        else:
            self._send_error_json(404, f"not found: {self.path}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--grok-home", default=str(pathlib.Path.home() / ".grok"))
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    global CLIENT_VERSION
    CLIENT_VERSION = detect_client_version()
    GrokProxyHandler.grok_home = pathlib.Path(args.grok_home).expanduser().resolve()
    server = ThreadingHTTPServer((args.host, args.port), GrokProxyHandler)
    print(f"grok-dsh-proxy listening on http://{args.host}:{args.port}/v1 (grok client {CLIENT_VERSION})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
