"""Exercise the real HTTP/WS bridge against a local, deterministic CDP peer.

Run with: python -m unittest discover -s tests -p 'test_controller*.py' -v
No installed Chrome, network access, or additional test framework is required.
"""

import asyncio
import json
import os
from pathlib import Path
import sys
import unittest

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import browser_controller


class MockCDP:
    def __init__(self):
        self.commands = []
        self.batch = []
        self.connections = set()
        self.tasks = set()
        self.target_exists = True
        self.extra_targets = []
        self.command_targets = []
        self.command_queue = asyncio.Queue()
        self.command_gates = {}
        self.command_errors = {}
        self.command_events = {}
        self.result_overrides = {}
        self.app = web.Application()
        self.app.router.add_get('/json/list', self.targets)
        self.app.router.add_get('/json', self.targets)
        self.app.router.add_get('/json/version', self.version)
        self.app.router.add_get('/devtools/page/{target_id}', self.websocket)
        self.app.router.add_get('/devtools/browser/mock', self.websocket)
        self.app.on_shutdown.append(self.shutdown)

    async def targets(self, request):
        targets = []
        if self.target_exists:
            targets.append({
                'id': 't1', 'type': 'page', 'title': 'Mock page',
                'url': 'https://example.test/',
                'webSocketDebuggerUrl': f'ws://{request.host}/devtools/page/t1',
            })
        targets.extend({
            'id': target_id, 'type': 'page', 'title': target_id,
            'url': 'https://example.test/' + target_id,
            'webSocketDebuggerUrl': f'ws://{request.host}/devtools/page/{target_id}',
        } for target_id in self.extra_targets)
        return web.json_response(targets)

    async def version(self, request):
        return web.json_response({
            'Browser': 'MockChrome/1.0', 'Protocol-Version': '1.3',
            'webSocketDebuggerUrl': f'ws://{request.host}/devtools/browser/mock',
        })

    async def websocket(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self.connections.add(ws)
        try:
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                payload = json.loads(msg.data)
                self.commands.append(payload)
                target_id = request.match_info.get('target_id', 'browser')
                self.command_targets.append((target_id, payload))
                self.command_queue.put_nowait((target_id, payload))
                task = asyncio.create_task(self.reply(ws, payload, target_id))
                self.tasks.add(task)
                task.add_done_callback(self.tasks.discard)
        finally:
            self.connections.discard(ws)
        return ws

    async def reply(self, ws, payload, target_id):
        method = payload['method']
        command_id = payload['id']
        params = payload.get('params', {})
        for event in self.command_events.get((target_id, method), ()):
            await ws.send_json(event)
        gate = self.command_gates.get((target_id, method))
        if gate is not None:
            await gate.wait()
        failure = self.command_errors.get((target_id, method))
        if failure is not None:
            await ws.send_json({'id': command_id, 'error': failure})
            return
        if method == 'Mock.hang':
            return
        if method == 'Mock.disconnect':
            await ws.close()
            return
        if method == 'Mock.error':
            await ws.send_json({
                'id': command_id,
                'error': {'code': -32601, 'message': 'Deliberate CDP error',
                          'data': 'mock diagnostic'},
            })
            return
        if method == 'Mock.reverse':
            self.batch.append((ws, payload))
            if len(self.batch) == 8:
                for socket, command in reversed(self.batch):
                    await socket.send_json({
                        'id': command['id'],
                        'result': {'marker': command['params']['marker']},
                    })
            return
        if method in self.result_overrides:
            result = self.result_overrides[method]
        elif method == 'Page.captureScreenshot':
            result = {'data': 'c2NyZWVuc2hvdA=='}
        elif method == 'Mock.echo':
            await asyncio.sleep(params.get('delay', 0))
            result = {'marker': params.get('marker')}
        elif method == 'Runtime.evaluate':
            result = {'result': {'type': 'number', 'value': 42}}
        else:
            result = {}
        if not ws.closed:
            await ws.send_json({'id': command_id, 'result': result})

    async def wait_for_command(self, target_id, method):
        async def matching_command():
            while True:
                target, command = await self.command_queue.get()
                if target == target_id and command['method'] == method:
                    return command
        return await asyncio.wait_for(matching_command(), timeout=2)

    async def shutdown(self, app):
        for task in list(self.tasks):
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        await asyncio.gather(*(ws.close() for ws in list(self.connections)))


class ControllerBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.mock = MockCDP()
        self.cdp = TestServer(self.mock.app)
        try:
            await self.cdp.start_server()
        except PermissionError as exc:
            self.skipTest(f'This runtime cannot listen on loopback: {exc}')
        self.addAsyncCleanup(self.cdp.close)
        app = browser_controller.create_app(
            str(self.cdp.make_url('')).rstrip('/'), token='test-secret'
        )
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)
        self.auth = {'Authorization': 'Bearer test-secret'}

    async def command(self, method, params=None, **extra):
        payload = {'targetId': 't1', 'method': method, 'params': params or {}}
        payload.update(extra)
        response = await self.client.post('/api/cdp', json=payload, headers=self.auth)
        return response.status, await response.json()

    def assert_failure(self, status, body):
        self.assertGreaterEqual(status, 400)
        self.assertFalse(body['ok'])
        self.assertTrue(body['error']['code'])
        self.assertTrue(body['error']['message'])

    async def test_health_tabs_and_cdp_result(self):
        response = await self.client.get('/health', headers=self.auth)
        self.assertEqual(response.status, 200)
        self.assertTrue((await response.json())['ok'])
        response = await self.client.get('/api/tabs', headers=self.auth)
        self.assertEqual(response.status, 200)
        body = await response.json()
        self.assertTrue(body['ok'])
        self.assertEqual([tab['id'] for tab in body['tabs']], ['t1'])
        status, body = await self.command('Runtime.evaluate', {'expression': '6 * 7'})
        self.assertEqual(status, 200)
        self.assertTrue(body['ok'])
        self.assertEqual(body['result']['result']['value'], 42)
        self.assertIn('id', body)

    async def test_eight_concurrent_commands_match_reversed_replies(self):
        answers = await asyncio.wait_for(asyncio.gather(*(
            self.command('Mock.reverse', {'marker': marker}) for marker in range(8)
        )), timeout=5)
        self.assertEqual([body['result']['marker'] for _, body in answers], list(range(8)))
        self.assertTrue(all(status == 200 and body['ok'] for status, body in answers))
        command_ids = [item['id'] for item in self.mock.commands if item['method'] == 'Mock.reverse']
        self.assertEqual(len(command_ids), 8)
        self.assertEqual(len(set(command_ids)), 8)

    async def test_generic_cdp_keeps_complex_params_sessions_and_protocol_results(self):
        params = {
            'functionDeclaration': 'async function(items) { return items.filter(x => x.enabled).map(x => ({name:x.name, value:x.values.reduce((a,b) => a*b, 1)})); }',
            'arguments': [{'value': [{'name': 'α', 'enabled': False, 'values': [0, 2], 'optional': None}]}],
            'awaitPromise': True, 'returnByValue': True,
        }
        result = {'result': {'type': 'object', 'value': {'nested': [False, 0, '', None, {'items': []}]}}}
        self.mock.result_overrides['Runtime.callFunctionOn'] = result
        status, body = await self.command(
            'Runtime.callFunctionOn', params, targetId='browser', sessionId='flattened-session',
        )
        self.assertEqual(status, 200)
        self.assertTrue(body['ok'])
        self.assertEqual(body['result'], result)
        target, sent = self.mock.command_targets[-1]
        self.assertEqual(target, 'browser')
        self.assertEqual(sent['params'], params)
        self.assertEqual(sent['sessionId'], 'flattened-session')
        script_exception = {
            'result': {'type': 'object', 'subtype': 'error', 'description': 'Error: deliberate'},
            'exceptionDetails': {'text': 'Uncaught', 'lineNumber': 0, 'columnNumber': 0},
        }
        self.mock.result_overrides['Runtime.evaluate'] = script_exception
        status, body = await self.command('Runtime.evaluate', {'expression': 'throw new Error("deliberate")'})
        self.assertEqual(status, 200)
        self.assertTrue(body['ok'], 'The bridge reports CDP protocol success, not JavaScript execution success')
        self.assertEqual(body['result'], script_exception)

    async def test_cdp_error_retains_upstream_details(self):
        status, body = await self.command('Mock.error')
        self.assert_failure(status, body)
        serialized = json.dumps(body)
        self.assertIn('Deliberate CDP error', serialized)
        self.assertIn('-32601', serialized)

    async def test_timeout_returns_error_and_later_command_still_works(self):
        status, body = await asyncio.wait_for(
            self.command('Mock.hang', timeout=0.1), timeout=2
        )
        self.assert_failure(status, body)
        status, body = await self.command('Mock.echo', {'marker': 'after-timeout'})
        self.assertEqual(status, 200)
        self.assertEqual(body['result'], {'marker': 'after-timeout'})

    async def test_disconnect_fails_pending_command_without_waiting_for_timeout(self):
        status, body = await asyncio.wait_for(
            self.command('Mock.disconnect', timeout=20), timeout=2
        )
        self.assert_failure(status, body)
        status, body = await self.command('Mock.echo', {'marker': 'reconnected'})
        self.assertEqual(status, 200)
        self.assertEqual(body['result'], {'marker': 'reconnected'})

    async def test_unknown_target_returns_explicit_error(self):
        status, body = await self.command('Mock.echo', targetId='does-not-exist')
        self.assert_failure(status, body)

    async def test_screenshot_uses_selected_target(self):
        response = await self.client.post(
            '/api/screenshot', json={'targetId': 't1'}, headers=self.auth
        )
        self.assertEqual(response.status, 200)
        body = await response.json()
        self.assertTrue(body['ok'])
        self.assertEqual(body['result']['data'], 'c2NyZWVuc2hvdA==')
        self.assertTrue(any(c['method'] == 'Page.captureScreenshot' for c in self.mock.commands))

    async def test_http_auth_is_required_and_query_token_is_not_accepted(self):
        for path in ('/health', '/api/tabs', '/api/tabs?token=test-secret'):
            response = await self.client.get(path)
            self.assertEqual(response.status, 401, path)
        response = await self.client.get(
            '/api/tabs', headers={'Authorization': 'Bearer wrong-secret'}
        )
        self.assertEqual(response.status, 401)
        response = await self.client.get('/')
        self.assertEqual(response.status, 200, 'The console must remain accessible for token entry')

    async def test_origin_must_match_server_even_with_valid_token(self):
        for origin in ('https://hostile.example', 'null'):
            response = await self.client.get(
                '/api/tabs', headers={**self.auth, 'Origin': origin}
            )
            self.assertEqual(response.status, 403, origin)
        origin = str(self.client.make_url('')).rstrip('/')
        response = await self.client.get(
            '/api/tabs', headers={**self.auth, 'Origin': origin}
        )
        self.assertEqual(response.status, 200)

    async def test_matching_attacker_host_and_origin_are_rejected(self):
        response = await self.client.get('/api/tabs', headers={
            **self.auth, 'Host': 'attacker.example', 'Origin': 'http://attacker.example',
        })
        self.assertEqual(response.status, 403)
        body = await response.json()
        self.assertEqual(body['error']['code'], 'forbidden_host')

    async def test_explicit_origin_allowlist_is_honored(self):
        origin = 'https://trusted-console.example'
        app = browser_controller.create_app(
            str(self.cdp.make_url('')).rstrip('/'), token='test-secret',
            allowed_origins=(origin,),
        )
        client = TestClient(TestServer(app))
        await client.start_server()
        self.addAsyncCleanup(client.close)
        response = await client.get('/api/tabs', headers={**self.auth, 'Origin': origin})
        self.assertEqual(response.status, 200)

    async def test_invalid_json_and_command_fields_return_json_errors(self):
        response = await self.client.post('/api/cdp', data='not json', headers=self.auth)
        self.assert_failure(response.status, await response.json())
        for extra in ({'params': []}, {'timeout': 0}, {'timeout': True},
                      {'targetId': None}, {'sessionId': 42}):
            payload = {'targetId': 't1', 'method': 'Mock.echo', **extra}
            response = await self.client.post('/api/cdp', json=payload, headers=self.auth)
            self.assert_failure(response.status, await response.json())

    async def test_websocket_requires_first_message_auth(self):
        first_messages = (
            {'action': 'auth', 'token': 'wrong-secret'},
            {'action': 'cdp', 'id': 'unauthenticated', 'targetId': 't1',
             'method': 'Mock.echo', 'params': {'marker': 'must-not-run'}},
        )
        for first_message in first_messages:
            async with self.client.ws_connect('/ws') as ws:
                await ws.send_json(first_message)
                message = await ws.receive(timeout=2)
                if message.type == aiohttp.WSMsgType.TEXT:
                    body = json.loads(message.data)
                    self.assertIn(body.get('type'), ('error', 'response'))
                    self.assertFalse(body.get('ok', False))
                else:
                    self.assertIn(message.type, (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED))
        self.assertFalse(any(c['method'] == 'Mock.echo' for c in self.mock.commands))

    async def test_websocket_command_responses_preserve_client_ids(self):
        async with self.client.ws_connect('/ws') as ws:
            await ws.send_json({'action': 'auth', 'token': 'test-secret'})
            ready = await ws.receive_json(timeout=2)
            self.assertEqual(ready['type'], 'ready')
            for marker in range(3):
                await ws.send_json({
                    'action': 'cdp', 'id': f'client-{marker}', 'targetId': 't1',
                    'method': 'Mock.echo',
                    'params': {'marker': marker, 'delay': (2 - marker) * 0.01},
                })
            received = {}
            while len(received) < 3:
                message = await ws.receive_json(timeout=2)
                if message.get('type') == 'response':
                    self.assertTrue(message['ok'], message)
                    received[message['id']] = message['result']['marker']
            self.assertEqual(received, {f'client-{i}': i for i in range(3)})

    async def test_websocket_origin_rejected_before_upgrade(self):
        with self.assertRaises(aiohttp.WSServerHandshakeError) as raised:
            await self.client.ws_connect('/ws', headers={'Origin': 'https://hostile.example'})
        self.assertEqual(raised.exception.status, 403)

    async def test_websocket_explicit_invalid_target_never_falls_back(self):
        async with self.client.ws_connect('/ws') as ws:
            await ws.send_json({'action': 'auth', 'token': 'test-secret'})
            await ws.receive_json(timeout=2)
            await ws.send_json({'action': 'select', 'id': 'initial', 'targetId': 't1'})
            self.assertEqual((await ws.receive_json(timeout=2))['type'], 'selected')
            for index, target in enumerate((None, '', False, 0, [], {})):
                with self.subTest(target=target):
                    await ws.send_json({
                        'action': 'cdp', 'id': index, 'targetId': target,
                        'method': 'Mock.echo', 'params': {'marker': 'must-not-run'},
                    })
                    body = await ws.receive_json(timeout=2)
                    self.assertFalse(body['ok'], body)
                    self.assertEqual(body['error']['code'], 'invalid_request')
            self.assertFalse(any(c['method'] == 'Mock.echo' for c in self.mock.commands))
            await ws.send_json({
                'action': 'cdp', 'id': 'omitted', 'method': 'Mock.echo',
                'params': {'marker': 'selected-target'},
            })
            self.assertEqual((await ws.receive_json(timeout=2))['result']['marker'], 'selected-target')

    async def test_failed_selection_keeps_confirmed_target_and_its_screencast(self):
        self.mock.extra_targets.append('t2')
        async with self.client.ws_connect('/ws') as ws:
            await ws.send_json({'action': 'auth', 'token': 'test-secret'})
            await ws.receive_json(timeout=2)
            await ws.send_json({'action': 'select', 'id': 'initial', 'targetId': 't1'})
            self.assertEqual((await ws.receive_json(timeout=2))['type'], 'selected')
            for method in ('Page.enable', 'Page.startScreencast'):
                with self.subTest(method=method):
                    self.mock.command_errors = {('t2', method): {
                        'code': -32000, 'message': 'Cannot prepare target picture',
                    }}
                    await ws.send_json({'action': 'select', 'id': method, 'targetId': 't2'})
                    body = await ws.receive_json(timeout=2)
                    self.assertFalse(body['ok'], body)
                    self.assertEqual(body['id'], method)
                    self.assertEqual(body['selectedTargetId'], 't1')
                    self.assertEqual(body['error']['data']['code'], -32000)
                    await ws.send_json({
                        'action': 'cdp', 'id': 'after-failure', 'method': 'Mock.echo',
                        'params': {'marker': method},
                    })
                    self.assertTrue((await ws.receive_json(timeout=2))['ok'])
                    echo_targets = [target for target, command in self.mock.command_targets
                                    if command['method'] == 'Mock.echo']
                    self.assertEqual(echo_targets[-1], 't1')
            self.assertFalse(any(target == 't1' and command['method'] == 'Page.stopScreencast'
                                 for target, command in self.mock.command_targets))

    async def test_concurrent_selection_only_confirms_latest_request(self):
        self.mock.extra_targets.extend(('t2', 't3'))
        gate = asyncio.Event()
        self.mock.command_gates[('t2', 'Page.startScreencast')] = gate
        async with self.client.ws_connect('/ws') as ws:
            await ws.send_json({'action': 'auth', 'token': 'test-secret'})
            await ws.receive_json(timeout=2)
            await ws.send_json({'action': 'select', 'id': 'initial', 'targetId': 't1'})
            await ws.receive_json(timeout=2)
            await ws.send_json({'action': 'select', 'id': 'older', 'targetId': 't2'})
            await self.mock.wait_for_command('t2', 'Page.startScreencast')
            await ws.send_json({'action': 'select', 'id': 'latest', 'targetId': 't3'})
            # This independent command confirms the server received the newer selection.
            await ws.send_json({'action': 'cdp', 'id': 'barrier', 'targetId': 't1', 'method': 'Mock.echo'})
            self.assertEqual((await ws.receive_json(timeout=2))['id'], 'barrier')
            gate.set()
            first, second = await ws.receive_json(timeout=2), await ws.receive_json(timeout=2)
            self.assertEqual(first['error']['code'], 'selection_superseded')
            self.assertEqual(first['selectedTargetId'], 't1')
            self.assertEqual(second, {'type': 'selected', 'id': 'latest', 'targetId': 't3'})
            await ws.send_json({'action': 'cdp', 'id': 'active', 'method': 'Mock.echo'})
            self.assertTrue((await ws.receive_json(timeout=2))['ok'])
            echo_targets = [target for target, command in self.mock.command_targets
                            if command['method'] == 'Mock.echo']
            self.assertEqual(echo_targets[-1], 't3')

    async def test_candidate_frame_is_delivered_without_committing_target_early(self):
        self.mock.extra_targets.append('t2')
        gate = asyncio.Event()
        self.mock.command_gates[('t2', 'Page.startScreencast')] = gate
        self.mock.command_events[('t2', 'Page.startScreencast')] = [{
            'method': 'Page.screencastFrame',
            'params': {'sessionId': 9, 'data': 'candidate-picture', 'metadata': {'deviceWidth': 1280}},
        }]
        async with self.client.ws_connect('/ws') as ws:
            await ws.send_json({'action': 'auth', 'token': 'test-secret'})
            await ws.receive_json(timeout=2)
            await ws.send_json({'action': 'select', 'id': 'initial', 'targetId': 't1'})
            await ws.receive_json(timeout=2)
            await ws.send_json({'action': 'select', 'id': 'candidate', 'targetId': 't2'})
            frame = await ws.receive_json(timeout=2)
            self.assertEqual(frame['type'], 'frame')
            self.assertEqual(frame['targetId'], 't2')
            self.assertEqual(frame['data'], 'candidate-picture')
            await ws.send_json({'action': 'cdp', 'id': 'while-preparing', 'method': 'Mock.echo'})
            self.assertTrue((await ws.receive_json(timeout=2))['ok'])
            echoes = [(target, command) for target, command in self.mock.command_targets
                      if command['method'] == 'Mock.echo']
            self.assertEqual(echoes[-1][0], 't1')
            gate.set()
            self.assertEqual(await ws.receive_json(timeout=2), {
                'type': 'selected', 'id': 'candidate', 'targetId': 't2',
            })

    async def test_invalid_selection_does_not_supersede_a_valid_pending_selection(self):
        self.mock.extra_targets.append('t2')
        gate = asyncio.Event()
        self.mock.command_gates[('t2', 'Page.startScreencast')] = gate
        async with self.client.ws_connect('/ws') as ws:
            await ws.send_json({'action': 'auth', 'token': 'test-secret'})
            await ws.receive_json(timeout=2)
            await ws.send_json({'action': 'select', 'id': 'initial', 'targetId': 't1'})
            await ws.receive_json(timeout=2)
            await ws.send_json({'action': 'select', 'id': 'valid-pending', 'targetId': 't2'})
            await self.mock.wait_for_command('t2', 'Page.startScreencast')
            await ws.send_json({'action': 'select', 'id': 'invalid', 'targetId': None})
            failure = await ws.receive_json(timeout=2)
            self.assertFalse(failure['ok'])
            self.assertEqual(failure['id'], 'invalid')
            self.assertEqual(failure['error']['code'], 'invalid_request')
            gate.set()
            self.assertEqual(await ws.receive_json(timeout=2), {
                'type': 'selected', 'id': 'valid-pending', 'targetId': 't2',
            })

    async def test_server_shutdown_closes_connected_websocket_promptly(self):
        ws = await self.client.ws_connect('/ws')
        await ws.send_json({'action': 'auth', 'token': 'test-secret'})
        self.assertEqual((await ws.receive_json(timeout=2))['type'], 'ready')
        # Keep reading as a browser would, so the close handshake can complete.
        read_close = asyncio.create_task(ws.receive(timeout=3))
        try:
            await asyncio.wait_for(self.client.server.close(), timeout=2)
            message = await read_close
        finally:
            if not read_close.done():
                read_close.cancel()
                await asyncio.gather(read_close, return_exceptions=True)
        self.assertIn(message.type, (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED))

    async def run_cli(self, *arguments, stdin=None, token='test-secret', base_flag=True, controller_url=None):
        env = os.environ.copy()
        env['NEKO_CONTROLLER_URL'] = controller_url or str(self.client.make_url('')).rstrip('/')
        if token is None:
            env.pop('NEKO_CONTROLLER_TOKEN', None)
        else:
            env['NEKO_CONTROLLER_TOKEN'] = token
        cli = Path(browser_controller.__file__).resolve().with_name('agent_cli.py')
        # Isolated mode confirms this CLI does not depend on project imports.
        args = [sys.executable, '-I', str(cli)]
        if base_flag:
            args += ['--base-url', env['NEKO_CONTROLLER_URL']]
        process = await asyncio.create_subprocess_exec(
            *args, *arguments, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(stdin.encode() if stdin is not None else b''), timeout=5
            )
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        return process.returncode, stdout.decode(), stderr.decode()

    async def test_cli_help_lists_available_commands(self):
        code, stdout, stderr = await self.run_cli('--help')
        self.assertEqual(code, 0)
        self.assertEqual(stderr, '')
        for command in ('health', 'tabs', 'cdp', 'screenshot'):
            self.assertIn(command, stdout)

    async def test_cli_health_tabs_and_environment_token(self):
        for command in ('health', 'tabs'):
            code, stdout, stderr = await self.run_cli(command, base_flag=False)
            self.assertEqual(code, 0, stderr)
            self.assertEqual(stderr, '')
            self.assertEqual(len(stdout.splitlines()), 1)
            self.assertTrue(json.loads(stdout)['ok'])
            self.assertNotIn('test-secret', stdout + stderr)

    async def test_cli_cdp_flags_and_json_stdin(self):
        code, stdout, stderr = await self.run_cli(
            'cdp', '--target', 't1', '--method', 'Runtime.evaluate',
            '--params', '{"expression":"6 * 7"}',
        )
        self.assertEqual(code, 0, stderr)
        self.assertEqual(json.loads(stdout)['result']['result']['value'], 42)
        code, stdout, stderr = await self.run_cli('cdp', stdin=json.dumps({
            'targetId': 't1', 'method': 'Mock.echo', 'params': {'marker': 'stdin-value'},
        }))
        self.assertEqual(code, 0, stderr)
        self.assertEqual(json.loads(stdout)['result']['marker'], 'stdin-value')

    async def test_cli_server_error_and_auth_failure_exit_one(self):
        code, stdout, stderr = await self.run_cli(
            'cdp', '--target', 't1', '--method', 'Mock.error'
        )
        self.assertEqual(code, 1)
        self.assertEqual(stderr, '')
        self.assertEqual(json.loads(stdout)['error']['code'], 'cdp_error')
        code, stdout, stderr = await self.run_cli('tabs', token=None)
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stdout)['error']['code'], 'unauthorized')

    async def test_cli_invalid_stdin_returns_json_and_exit_two(self):
        for stdin in ('not-json', '[]', '{"timeout":false}'):
            code, stdout, stderr = await self.run_cli('cdp', stdin=stdin)
            self.assertEqual(code, 2)
            self.assertEqual(stderr, '')
            body = json.loads(stdout)
            self.assertFalse(body['ok'])
            self.assertEqual(body['error']['code'], 'invalid_input')

    async def test_cli_requires_boolean_ok_and_http_success(self):
        response_config = {}
        async def response(request):
            return web.json_response(response_config['body'], status=response_config['status'])
        app = web.Application()
        app.router.add_get('/health', response)
        server = TestServer(app)
        await server.start_server()
        self.addAsyncCleanup(server.close)
        url = str(server.make_url('')).rstrip('/')
        for malformed_ok in ('false', 'true', 0, 1, None, [], {}):
            with self.subTest(ok=malformed_ok):
                response_config.update(body={'ok': malformed_ok}, status=200)
                code, stdout, stderr = await self.run_cli('health', controller_url=url)
                self.assertEqual(code, 1, stdout)
                self.assertEqual(stderr, '')
                self.assertEqual(json.loads(stdout)['error']['code'], 'invalid_response')
        response_config.update(body={'ok': True, 'result': {}}, status=503)
        code, stdout, stderr = await self.run_cli('health', controller_url=url)
        self.assertEqual(code, 1, stdout)
        self.assertEqual(json.loads(stdout)['error']['code'], 'http_error')
        service_error = {'ok': False, 'error': {
            'code': 'busy', 'message': 'Try later', 'data': {'retryAfter': 2},
        }}
        response_config.update(body=service_error, status=503)
        code, stdout, stderr = await self.run_cli('health', controller_url=url)
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stdout), service_error)


class ControllerConfigurationTests(unittest.TestCase):
    def test_remote_bind_requires_token(self):
        for host in ('0.0.0.0', '::', '192.0.2.3'):
            with self.subTest(host=host), self.assertRaises(ValueError):
                browser_controller.create_app('http://127.0.0.1:9222', bind_host=host)


if __name__ == '__main__':
    unittest.main()
