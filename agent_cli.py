"""Standard-library CLI for a running controller. One JSON response on stdout.

Examples:
  python agent_cli.py health
  python agent_cli.py tabs
  python agent_cli.py cdp --target TAB_ID --method Runtime.evaluate --params '{"expression":"document.title","returnByValue":true}'
  python agent_cli.py cdp < request.json
Set NEKO_CONTROLLER_TOKEN in the environment when the controller uses a token.
Exit codes: 0 success, 1 server/transport error, 2 invalid CLI/input.
"""
import argparse
import ipaddress
import json
import math
import os
import sys
from urllib import error, request
from urllib.parse import urlsplit


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))


def failure(code, message):
    return {"ok": False, "error": {"code": code, "message": message}}


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A configured controller is an exact endpoint. Never forward its token
        # to a redirect destination.
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=os.environ.get("NEKO_CONTROLLER_URL", "http://127.0.0.1:8899"), help="Controller URL (or NEKO_CONTROLLER_URL). Token: NEKO_CONTROLLER_TOKEN.")
    parser.add_argument("--timeout", type=float, default=15, help="CDP command timeout in seconds (default: 15).")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("health", help="Check browser CDP availability.")
    commands.add_parser("tabs", help="List current page targets.")
    cdp = commands.add_parser("cdp", help="Send generic CDP; omit --method to read a request object from stdin.")
    cdp.add_argument("--target", help="Target id from tabs, or 'browser' for browser-level CDP.")
    cdp.add_argument("--method", help="CDP method, e.g. Runtime.evaluate.")
    cdp.add_argument("--params", default="{}", help="JSON object (for complex input use stdin).")
    cdp.add_argument("--session-id", help="Optional flattened CDP session id.")
    shot = commands.add_parser("screenshot", help="Return Page.captureScreenshot result with base64 data.")
    shot.add_argument("--target", required=True)
    shot.add_argument("--params", default="{}", help="Page.captureScreenshot parameters as JSON.")
    args = parser.parse_args(argv)
    try:
        base = urlsplit(args.base_url)
        if base.scheme not in ("http", "https") or not base.hostname or base.username or base.password or base.query or base.fragment:
            raise ValueError("--base-url must be HTTP(S), without credentials, query, or fragment.")
        if not math.isfinite(args.timeout) or args.timeout <= 0:
            raise ValueError("--timeout must be a finite positive number.")
        body = None
        if args.command == "cdp":
            if args.method:
                if not args.target:
                    raise ValueError("--target is required with --method.")
                body = {"targetId": args.target, "method": args.method, "params": json.loads(args.params), "timeout": args.timeout}
                if args.session_id:
                    body["sessionId"] = args.session_id
            else:
                if sys.stdin.isatty():
                    raise ValueError("Provide --target and --method, or pipe a JSON request to stdin.")
                body = json.load(sys.stdin)
                if not isinstance(body, dict):
                    raise ValueError("stdin must contain a JSON object.")
                body.setdefault("timeout", args.timeout)
        elif args.command == "screenshot":
            body = {"targetId": args.target, "params": json.loads(args.params), "timeout": args.timeout}
        effective_timeout = body.get("timeout", args.timeout) if body else args.timeout
        if isinstance(effective_timeout, bool) or not isinstance(effective_timeout, (int, float)) or not math.isfinite(effective_timeout) or effective_timeout <= 0:
            raise ValueError("Request timeout must be a finite positive number.")
        path = "/health" if args.command == "health" else "/api/" + args.command
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        token = os.environ.get("NEKO_CONTROLLER_TOKEN")
        if token:
            if not token.isascii() or any(ord(char) < 33 or ord(char) > 126 for char in token):
                raise ValueError("NEKO_CONTROLLER_TOKEN must contain printable ASCII without whitespace.")
            headers["Authorization"] = "Bearer " + token
        req = request.Request(args.base_url.rstrip("/") + path, data=json.dumps(body).encode("utf-8") if body is not None else None, headers=headers)
        try:
            local_endpoint = ipaddress.ip_address(base.hostname).is_loopback
        except ValueError:
            local_endpoint = base.hostname.lower() == "localhost"
        # Preserve runtime proxy and CA configuration for remote controllers.
        proxy = request.ProxyHandler({}) if local_endpoint else request.ProxyHandler()
        opener = request.build_opener(proxy, NoRedirect())
        http_status = None
        try:
            with opener.open(req, timeout=effective_timeout + 15) as response:
                http_status = response.status
                try:
                    payload = json.load(response)
                except (ValueError, UnicodeDecodeError):
                    payload = failure("invalid_response", "Controller did not return valid JSON.")
        except error.HTTPError as exc:
            http_status = exc.code
            try:
                payload = json.load(exc)
            except (ValueError, UnicodeDecodeError):
                payload = failure("http_error", f"Controller returned HTTP {exc.code}.")
        if not isinstance(payload, dict) or not isinstance(payload.get("ok"), bool):
            payload = failure("invalid_response", "Controller did not return the expected JSON envelope.")
        elif http_status is not None and not 200 <= http_status < 300 and payload["ok"]:
            payload = failure("http_error", f"Controller returned HTTP {http_status}.")
        emit(payload)
        return 0 if payload.get("ok") is True else 1
    except (ValueError, TypeError, UnicodeDecodeError) as exc:
        emit(failure("invalid_input", str(exc)))
        return 2
    except (error.URLError, OSError) as exc:
        # Do not echo request headers, credentials, or arbitrary remote payloads.
        emit(failure("connection_error", f"Cannot reach controller ({type(exc).__name__}). Check --base-url and the controller process."))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
