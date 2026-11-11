"""Local visual console and result-bearing CDP bridge.

GET /health, GET /api/tabs, POST /api/cdp, POST /api/screenshot.
CDP body: {"targetId": "..." | "browser", "method": "Runtime.evaluate",
           "params": {...}, "timeout": 15, "sessionId": "optional"}.
Responses: {"ok": true, "id": N, "result": ...} or
           {"ok": false, "error": {"code": "...", "message": "...", ...}}.
Commands are never retried: after a timeout/disconnect, execution may already
have occurred. Inspect browser state before repeating a mutation.
"""
import argparse
import asyncio
import contextlib
import ipaddress
import itertools
import json
import math
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
from urllib.parse import urlsplit
import webbrowser

import aiohttp
from aiohttp import web

ROOT = Path(__file__).resolve().parent
STATE = web.AppKey("controller", object)


class BridgeError(Exception):
    def __init__(self, code, message, status=502, data=None):
        super().__init__(message)
        self.code, self.status, self.data = code, status, data

    def payload(self):
        error = {"code": self.code, "message": str(self)}
        if self.data is not None:
            error["data"] = self.data
        return {"ok": False, "error": error}


def is_loopback(host):
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class CDPConnection:
    """One reader owns a CDP socket; futures correlate concurrent commands."""
    def __init__(self, session, ws_url, ids=None, event_handler=None):
        self.session, self.ws_url = session, ws_url
        self.ids = ids if ids is not None else itertools.count(1)
        self.event_handler = event_handler
        self.ws = self.reader = None
        self.pending = {}

    @property
    def connected(self):
        return self.ws is not None and not self.ws.closed and self.reader is not None and not self.reader.done()

    async def connect(self):
        try:
            self.ws = await self.session.ws_connect(self.ws_url, heartbeat=20)
        except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as exc:
            raise BridgeError("cdp_unavailable", "Cannot connect to the CDP target.") from exc
        self.reader = asyncio.create_task(self._read())
        return self

    async def command(self, method, params=None, timeout=15, session_id=None):
        if not self.connected:
            raise BridgeError("disconnected", "The CDP target is disconnected.")
        request_id = next(self.ids)
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        payload = {"id": request_id, "method": method, "params": params or {}}
        if session_id is not None:
            payload["sessionId"] = session_id
        try:
            await self.ws.send_json(payload)
            response = await asyncio.wait_for(future, timeout)
            if "error" in response:
                raise BridgeError("cdp_error", response["error"].get("message", "CDP command failed."), data=response["error"])
            return {"ok": True, "id": request_id, "result": response.get("result", {})}
        except asyncio.TimeoutError as exc:
            raise BridgeError("timeout", f"CDP command timed out after {timeout:g} seconds; execution may have occurred.", 504) from exc
        except (aiohttp.ClientError, ConnectionError, OSError) as exc:
            raise BridgeError("disconnected", "The CDP connection was lost; execution may have occurred.") from exc
        finally:
            self.pending.pop(request_id, None)
            if not future.done():
                future.cancel()

    async def _read(self):
        try:
            async for message in self.ws:
                if message.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(message.data)
                except (ValueError, TypeError):
                    continue
                if not isinstance(data, dict):
                    continue
                future = self.pending.get(data.get("id"))
                if future is not None and not future.done():
                    future.set_result(data)
                elif data.get("method") and self.event_handler:
                    await self.event_handler(self, data)
        except (aiohttp.ClientError, ConnectionError, OSError):
            pass
        finally:
            for future in list(self.pending.values()):
                if not future.done():
                    future.set_exception(BridgeError("disconnected", "The CDP target disconnected; execution may have occurred."))
            if self.event_handler:
                await self.event_handler(self, {"method": "controller.disconnected"})

    async def close(self):
        if self.ws is not None:
            await self.ws.close()
        if self.reader is not None and self.reader is not asyncio.current_task():
            self.reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.reader


class Controller:
    def __init__(self, cdp_url, token, bind_host, allowed_origins):
        parsed = urlsplit(cdp_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("CDP URL must be an HTTP(S) endpoint without credentials, query, or fragment.")
        if not is_loopback(bind_host) and not token:
            raise ValueError("A non-loopback bind requires NEKO_CONTROLLER_TOKEN or --token-file.")
        self.cdp_url = cdp_url.rstrip("/")
        self.token, self.bind_host = token, bind_host
        self.allowed_origins = set(allowed_origins)
        self.session = None
        self.connections, self.locks, self.clients, self.client_queues = {}, {}, {}, {}
        self.selecting_targets = {}
        self.ids = itertools.count(1)

    async def start(self, app):
        # Direct access is appropriate only for the explicitly local endpoint.
        # Remote endpoints retain the runtime's proxy and CA configuration.
        local_endpoint = is_loopback(urlsplit(self.cdp_url).hostname)
        self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10, connect=5), trust_env=not local_endpoint)

    async def shutdown(self, app):
        await asyncio.gather(*(ws.close(code=1001, message=b"Controller shutting down") for ws in list(self.clients)), return_exceptions=True)

    async def close(self, app):
        await asyncio.gather(*(conn.close() for conn in list(self.connections.values())), return_exceptions=True)
        if self.session is not None:
            await self.session.close()

    async def fetch(self, path):
        try:
            async with self.session.get(self.cdp_url + path) as response:
                response.raise_for_status()
                return await response.json()
        except (aiohttp.ClientError, OSError, asyncio.TimeoutError, ValueError) as exc:
            raise BridgeError("cdp_unavailable", "The browser CDP endpoint is unavailable.", 503) from exc

    async def targets(self):
        result = await self.fetch("/json/list")
        if not isinstance(result, list):
            raise BridgeError("invalid_cdp_response", "CDP returned an invalid target list.")
        return result

    async def tabs(self):
        return [{k: t[k] for k in ("id", "type", "title", "url") if k in t}
                for t in await self.targets() if t.get("type") == "page"]

    async def connection(self, target_id):
        async with self.locks.setdefault(target_id, asyncio.Lock()):
            existing = self.connections.get(target_id)
            if existing and existing.connected:
                return existing
            if existing:
                await existing.close()
                self.connections.pop(target_id, None)
            target = await self.fetch("/json/version") if target_id == "browser" else next((t for t in await self.targets() if t.get("id") == target_id), None)
            if not target or not target.get("webSocketDebuggerUrl"):
                raise BridgeError("target_not_found", "The requested CDP target no longer exists or is not inspectable.", 404)
            async def on_event(conn, event):
                await self.event(target_id, conn, event)
            conn = CDPConnection(self.session, target["webSocketDebuggerUrl"], self.ids, on_event)
            await conn.connect()
            self.connections[target_id] = conn
            return conn

    async def execute(self, body):
        if not isinstance(body, dict):
            raise BridgeError("invalid_request", "JSON body must be an object.", 400)
        target_id, method = body.get("targetId"), body.get("method")
        params, timeout = body.get("params", {}), body.get("timeout", 15)
        if not isinstance(target_id, str) or not target_id or not isinstance(method, str) or not method:
            raise BridgeError("invalid_request", "targetId and method must be nonempty strings.", 400)
        if not isinstance(params, dict) or isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise BridgeError("invalid_request", "params must be an object and timeout must be a finite positive number of seconds.", 400)
        session_id = body.get("sessionId")
        if session_id is not None and not isinstance(session_id, str):
            raise BridgeError("invalid_request", "sessionId must be a string.", 400)
        async def execute_once():
            conn = await self.connection(target_id)
            return await conn.command(method, params, timeout, session_id)
        try:
            return await asyncio.wait_for(execute_once(), timeout)
        except asyncio.TimeoutError as exc:
            raise BridgeError("timeout", f"CDP request timed out after {timeout:g} seconds; execution may have occurred.", 504) from exc

    async def stop_unused_screencast(self, target_id):
        if target_id and target_id not in self.clients.values() and target_id not in self.selecting_targets.values():
            conn = self.connections.get(target_id)
            if conn and conn.connected:
                with contextlib.suppress(BridgeError):
                    await conn.command("Page.stopScreencast", timeout=2)

    async def event(self, target_id, conn, data):
        method, params = data.get("method"), data.get("params", {})
        payload = None
        if method == "Page.screencastFrame":
            await conn.ws.send_json({"id": next(self.ids), "method": "Page.screencastFrameAck", "params": {"sessionId": params["sessionId"]}})
            payload = {"type": "frame", "data": params["data"], "metadata": params.get("metadata", {})}
        elif method == "Page.frameNavigated" and not params.get("frame", {}).get("parentId"):
            payload = {"type": "urlUpdate", "url": params.get("frame", {}).get("url", "")}
        elif method == "controller.disconnected":
            payload = {"type": "error", "ok": False, "error": {"code": "disconnected", "message": "Browser target disconnected. Refresh tabs and select a target to reconnect."}}
        if payload:
            payload["targetId"] = target_id
            clients = [ws for ws, selected in list(self.clients.items())
                       if (selected == target_id or self.selecting_targets.get(ws) == target_id) and not ws.closed]
            for ws in clients:
                queue = self.client_queues.get(ws)
                if queue is not None:
                    # A slow screen viewer must never hold up CDP response matching.
                    if queue.full():
                        queue.get_nowait()
                    queue.put_nowait(payload)


def authorized(controller, supplied):
    return not controller.token or (isinstance(supplied, str) and secrets.compare_digest(supplied.encode(), controller.token.encode()))


@web.middleware
async def security(request, handler):
    controller = request.app[STATE]
    try:
        try:
            host = urlsplit("//" + request.host).hostname
        except ValueError as exc:
            raise BridgeError("forbidden_host", "Invalid Host header.", 403) from exc
        if is_loopback(controller.bind_host) and not (host and is_loopback(host)):
            raise BridgeError("forbidden_host", "Host is not a loopback address.", 403)
        origin = request.headers.get("Origin")
        if origin is not None and origin != f"{request.scheme}://{request.host}" and origin not in controller.allowed_origins:
            raise BridgeError("forbidden_origin", "Origin is not allowed.", 403)
        if request.path not in ("/", "/controller_ui.js", "/ws"):
            header = request.headers.get("Authorization", "")
            supplied = header[7:] if header.startswith("Bearer ") else None
            if not authorized(controller, supplied):
                raise BridgeError("unauthorized", "A valid bearer token is required.", 401)
        return await handler(request)
    except BridgeError as exc:
        return web.json_response(exc.payload(), status=exc.status, headers={"Cache-Control": "no-store"})
    except web.HTTPException as exc:
        return web.json_response(BridgeError("http_error", exc.reason, exc.status).payload(), status=exc.status)


async def json_body(request):
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError) as exc:
        raise BridgeError("invalid_json", "Request body must contain valid JSON.", 400) from exc
    if not isinstance(body, dict):
        raise BridgeError("invalid_request", "JSON body must be an object.", 400)
    return body


async def index_handler(request):
    return web.FileResponse(ROOT / "controller_ui.html", headers={"Cache-Control": "no-store"})


async def script_handler(request):
    return web.FileResponse(ROOT / "controller_ui.js", headers={"Cache-Control": "no-store"})


async def health_handler(request):
    version = await request.app[STATE].fetch("/json/version")
    return web.json_response({"ok": True, "browser": version.get("Browser", "unknown"), "cdpConnected": True})


async def tabs_handler(request):
    return web.json_response({"ok": True, "tabs": await request.app[STATE].tabs()})


async def cdp_handler(request):
    return web.json_response(await request.app[STATE].execute(await json_body(request)))


async def screenshot_handler(request):
    body = await json_body(request)
    body["method"] = "Page.captureScreenshot"
    return web.json_response(await request.app[STATE].execute(body))


async def ws_handler(request):
    controller = request.app[STATE]
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=4 * 1024 * 1024)
    await ws.prepare(request)
    tasks, pending_ids = set(), set()
    select_lock = asyncio.Lock()
    selection_version = 0
    event_sender = None

    async def send_events(queue):
        try:
            while True:
                payload = await queue.get()
                await asyncio.wait_for(ws.send_json(payload), 5)
        except (aiohttp.ClientError, ConnectionError, asyncio.TimeoutError):
            await ws.close(code=1001, message=b"Viewer is disconnected or too slow")

    async def respond(data, requested_version=None):
        client_id = data.get("id")
        try:
            action = data.get("action")
            if action == "tabs":
                await ws.send_json({"type": "tabs", "tabs": await controller.tabs()})
                return
            if action == "select":
                target_id = data.get("targetId")
                if not isinstance(target_id, str) or not target_id:
                    raise BridgeError("invalid_request", "Select requires a targetId.", 400)
                async with select_lock:
                    if requested_version != selection_version:
                        raise BridgeError("selection_superseded", "A newer target selection was requested.", 409)
                    controller.selecting_targets[ws] = target_id
                    try:
                        conn = await controller.connection(target_id)
                        await conn.command("Page.enable")
                        await conn.command("Page.startScreencast", {"format": "jpeg", "quality": 80, "maxWidth": 1280, "maxHeight": 800})
                        if requested_version != selection_version:
                            raise BridgeError("selection_superseded", "A newer target selection was requested.", 409)
                        previous = controller.clients.get(ws)
                        controller.clients[ws] = target_id
                        await ws.send_json({"type": "selected", "id": client_id, "targetId": target_id})
                        if previous != target_id:
                            await controller.stop_unused_screencast(previous)
                    finally:
                        controller.selecting_targets.pop(ws, None)
                        if controller.clients.get(ws) != target_id:
                            await controller.stop_unused_screencast(target_id)
                return
            if action != "cdp":
                raise BridgeError("invalid_request", "Unknown WebSocket action.", 400)
            if "targetId" not in data:
                data["targetId"] = controller.clients.get(ws)
            result = await controller.execute(data)
            await ws.send_json({**result, "type": "response", "id": client_id})
        except BridgeError as exc:
            if not ws.closed:
                payload = {**exc.payload(), "type": "response", "id": client_id}
                if data.get("action") == "select":
                    payload.update(action="select", targetId=data.get("targetId"), selectedTargetId=controller.clients.get(ws))
                await ws.send_json(payload)
        except (aiohttp.ClientError, ConnectionError):
            pass
        finally:
            if data.get("action") == "cdp":
                pending_ids.discard(client_id)

    try:
        try:
            auth = await ws.receive_json(timeout=10)
        except (ValueError, TypeError, asyncio.TimeoutError):
            auth = None
        if not isinstance(auth, dict) or auth.get("action") != "auth" or not authorized(controller, auth.get("token")):
            await ws.send_json({"type": "error", "ok": False, "error": {"code": "unauthorized", "message": "First message must authenticate."}})
            await ws.close(code=1008)
            return ws
        controller.clients[ws] = None
        queue = asyncio.Queue(maxsize=8)
        controller.client_queues[ws] = queue
        event_sender = asyncio.create_task(send_events(queue))
        await ws.send_json({"type": "ready", "tabs": await controller.tabs()})
        async for message in ws:
            if message.type != aiohttp.WSMsgType.TEXT:
                continue
            try:
                data = json.loads(message.data)
                if not isinstance(data, dict):
                    raise ValueError
                client_id = data.get("id")
                if data.get("action") == "cdp":
                    if isinstance(client_id, bool) or not isinstance(client_id, (int, str)) or client_id in pending_ids:
                        raise ValueError
                    pending_ids.add(client_id)
                requested_version = None
                if data.get("action") == "select" and isinstance(data.get("targetId"), str) and data["targetId"]:
                    selection_version += 1
                    requested_version = selection_version
                task = asyncio.create_task(respond(data, requested_version))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
            except (ValueError, TypeError):
                await ws.send_json({"type": "error", "ok": False, "error": {"code": "invalid_request", "message": "Expected a JSON object and a unique string/integer id for CDP commands."}})
    except BridgeError as exc:
        await ws.send_json({**exc.payload(), "type": "error"})
    finally:
        selected = controller.clients.pop(ws, None)
        controller.client_queues.pop(ws, None)
        controller.selecting_targets.pop(ws, None)
        if event_sender:
            event_sender.cancel()
            await asyncio.gather(event_sender, return_exceptions=True)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await controller.stop_unused_screencast(selected)
        await ws.close()
    return ws


def create_app(cdp_url="http://127.0.0.1:9222", token=None, bind_host="127.0.0.1", allowed_origins=()):
    controller = Controller(cdp_url, token, bind_host, allowed_origins)
    app = web.Application(middlewares=[security], client_max_size=4 * 1024 * 1024)
    app[STATE] = controller
    app.on_startup.append(controller.start)
    app.on_shutdown.append(controller.shutdown)
    app.on_cleanup.append(controller.close)
    app.add_routes([web.get("/", index_handler), web.get("/controller_ui.js", script_handler), web.get("/health", health_handler),
                    web.get("/api/tabs", tabs_handler), web.post("/api/cdp", cdp_handler),
                    web.post("/api/screenshot", screenshot_handler), web.get("/ws", ws_handler)])
    return app


def find_chrome(explicit=None):
    if explicit:
        path = shutil.which(explicit) or (explicit if Path(explicit).is_file() else None)
        if not path:
            raise ValueError("Chrome executable not found. Check --chrome.")
        return str(path)
    candidates = [path for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "msedge") if (path := shutil.which(name))]
    for root in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")):
        if root:
            candidates.extend(str(Path(root) / relative) for relative in ("Google/Chrome/Application/chrome.exe", "Chromium/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"))
    candidates.extend(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"])
    for path in candidates:
        if Path(path).is_file():
            return path
    raise ValueError("Chrome/Chromium not found. Supply --chrome PATH, or use --attach http://127.0.0.1:9222.")


def launch_browser(args):
    chrome = find_chrome(args.chrome)
    extension, profile = Path(args.extension).expanduser().resolve(), Path(args.profile).expanduser().resolve()
    if not (extension / "manifest.json").is_file():
        raise ValueError("--extension must point to an unpacked extension containing manifest.json.")
    normal_profiles = [Path.home() / ".config" / name for name in ("google-chrome", "chromium", "microsoft-edge")]
    normal_profiles += [Path.home() / "Library/Application Support" / name for name in ("Google/Chrome", "Chromium", "Microsoft Edge")]
    if os.environ.get("LOCALAPPDATA"):
        normal_profiles += [Path(os.environ["LOCALAPPDATA"]) / name for name in ("Google/Chrome/User Data", "Chromium/User Data", "Microsoft/Edge/User Data")]
    if any(profile == p.resolve() or p.resolve() in profile.parents for p in normal_profiles):
        raise ValueError("--profile must be a dedicated controller directory, separate from a normal browser profile. Use --attach for an existing debug browser.")
    profile.mkdir(parents=True, exist_ok=True)
    if args.cdp_port:
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", args.cdp_port))
            except OSError as exc:
                raise ValueError("CDP port is unavailable. Use --attach for an existing debug browser, or select another --cdp-port.") from exc
    active_port = profile / "DevToolsActivePort"
    old_stat = active_port.stat().st_mtime_ns if active_port.exists() else None
    command = [chrome, "--remote-debugging-address=127.0.0.1", f"--remote-debugging-port={args.cdp_port}",
               f"--user-data-dir={profile}", f"--load-extension={extension}", "--no-first-run",
               "--no-default-browser-check", "--window-size=1280,800", "--new-window", args.url]
    return subprocess.Popen(command), active_port, old_stat


async def wait_for_browser(process, active_port, old_stat, port):
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=1), trust_env=False) as session:
        for _ in range(60):
            if process.poll() is not None:
                raise ValueError("Chrome exited before CDP was ready. Check the browser output, executable, and dedicated profile.")
            if not port:
                try:
                    if active_port.stat().st_mtime_ns != old_stat:
                        port = int(active_port.read_text().splitlines()[0])
                except (OSError, ValueError, IndexError):
                    pass
            if port:
                try:
                    url = f"http://127.0.0.1:{port}"
                    async with session.get(url + "/json/version") as response:
                        if response.status == 200:
                            return url
                except (aiohttp.ClientError, OSError, asyncio.TimeoutError):
                    pass
            await asyncio.sleep(0.25)
    raise ValueError("Timed out waiting for Chrome's CDP endpoint.")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Local visual Chrome console and JSON CDP bridge.")
    parser.add_argument("--host", default="127.0.0.1", help="Listen address. Non-loopback requires a token (default: 127.0.0.1).")
    parser.add_argument("--port", type=int, default=8899)
    parser.add_argument("--attach", metavar="CDP_URL", help="Attach to an existing debug browser; never launch or terminate it.")
    parser.add_argument("--chrome", help="Chrome/Chromium executable; otherwise discovered automatically.")
    parser.add_argument("--extension", default=str(ROOT), help="Unpacked extension directory (default: this repository).")
    parser.add_argument("--profile", default=str(Path.home() / ".neko-video-downloader" / "controller-profile"), help="Dedicated browser directory; default is isolated from normal profiles.")
    parser.add_argument("--cdp-port", type=int, default=0, help="Debug port when launching (default: automatically assigned).")
    parser.add_argument("--url", default="about:blank", help="Initial page when launching a browser.")
    parser.add_argument("--token-file", help="Read token from a UTF-8 file; otherwise use NEKO_CONTROLLER_TOKEN.")
    parser.add_argument("--allow-origin", action="append", default=[], help="Additional exact browser Origin; repeat as needed.")
    parser.add_argument("--open", action="store_true", help="Open the visual console after the server starts.")
    return parser.parse_args(argv)


async def main(argv=None):
    args = parse_args(argv)
    token = Path(args.token_file).read_text(encoding="utf-8").strip() if args.token_file else os.environ.get("NEKO_CONTROLLER_TOKEN")
    if args.token_file and not token:
        raise ValueError("The token file is empty.")
    if not is_loopback(args.host) and not token:
        raise ValueError("A non-loopback bind requires NEKO_CONTROLLER_TOKEN or --token-file.")
    process, runner = None, None
    try:
        if args.attach:
            cdp_url = args.attach
        else:
            process, active_port, old_stat = launch_browser(args)
            cdp_url = await wait_for_browser(process, active_port, old_stat, args.cdp_port)
        app = create_app(cdp_url, token=token, bind_host=args.host, allowed_origins=args.allow_origin)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, args.host, args.port).start()
        display_host = "127.0.0.1" if args.host == "0.0.0.0" else ("[::1]" if args.host == "::" else args.host)
        if ":" in display_host and not display_host.startswith("["):
            display_host = f"[{display_host}]"
        console_url = f"http://{display_host}:{args.port}"
        print(f"Browser console: {console_url}\nCDP endpoint: {cdp_url}\nAuthentication: {'token required' if token else 'loopback only'}\nPress Ctrl+C to stop.", flush=True)
        if not args.attach:
            print("普通 Chrome 首次请在新浏览器窗口打开 chrome://extensions，开启开发者模式并加载本项目。\nChromium / Chrome for Testing 可通过命令行加载；本控制器不保证普通 Chrome 接受 --load-extension。", flush=True)
            print(f"Extension directory: {Path(args.extension).expanduser().resolve()}", flush=True)
        if args.open:
            webbrowser.open(console_url)
        await asyncio.Event().wait()
    finally:
        if runner:
            await runner.cleanup()
        if process and process.poll() is None:
            process.terminate()
            try:
                await asyncio.to_thread(process.wait, timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                await asyncio.to_thread(process.wait)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Controller stopped.")
    except (ValueError, OSError) as exc:
        print(f"Controller error: {exc}", file=sys.stderr)
        sys.exit(1)
