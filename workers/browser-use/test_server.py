import asyncio
import os
import sys
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import server

TOKEN = 'test-secret-that-is-longer-than-32-characters'


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {'BROWSER_USE_WORKER_TOKEN': TOKEN})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_health_and_authentication_precedes_allocation(self):
        with TestClient(server.app) as client:
            self.assertEqual(client.get('/healthz').json(), {'status': 'ok', 'service': 'browser-use-worker'})
            with patch.object(server.asyncio, 'create_subprocess_exec') as spawn:
                with self.assertRaises(WebSocketDisconnect):
                    with client.websocket_connect('/run'):
                        pass
                spawn.assert_not_called()

    def test_binary_configuration_is_rejected_without_starting_child(self):
        with TestClient(server.app) as client, patch.object(server.asyncio, 'create_subprocess_exec') as spawn:
            with client.websocket_connect('/run', headers={'Authorization': 'Bearer ' + TOKEN}) as socket:
                socket.send_bytes(b'{}')
                self.assertEqual(socket.receive_json(), {'type': 'failure'})
            spawn.assert_not_called()

    def test_saturated_instance_rejects_before_allocation(self):
        with patch.object(server, 'capacity', asyncio.Semaphore(0)), TestClient(server.app) as client:
            with patch.object(server.asyncio, 'create_subprocess_exec') as spawn:
                with self.assertRaises(WebSocketDisconnect):
                    with client.websocket_connect('/run', headers={'Authorization': 'Bearer ' + TOKEN}):
                        pass
                spawn.assert_not_called()

    def synthetic_process(self, script):
        original = asyncio.create_subprocess_exec
        children = []
        async def spawn(*args, **kwargs):
            process = await original(sys.executable, '-c', script, **kwargs)
            children.append(process)
            return process
        return spawn, children

    def test_single_connection_relays_protocol_and_reaps_process(self):
        spawn, children = self.synthetic_process('''
import json, sys
config = json.loads(input())
assert config['task'] == 'synthetic'
print('{"type":"reserve"}', flush=True)
assert json.loads(input()) == {'ok': True}
print('{"type":"tool","name":"observe","arguments":{}}', flush=True)
assert json.loads(input()) == {'done': True}
print('{"type":"complete"}', flush=True)
''')
        with patch.object(server.asyncio, 'create_subprocess_exec', spawn), TestClient(server.app) as client:
            with client.websocket_connect('/run', headers={'Authorization': 'Bearer ' + TOKEN}) as socket:
                socket.send_json({'task': 'synthetic'})
                self.assertEqual(socket.receive_json(), {'type': 'reserve'})
                socket.send_json({'ok': True})
                self.assertEqual(socket.receive_json()['type'], 'tool')
                socket.send_json({'done': True})
                self.assertEqual(socket.receive_json(), {'type': 'complete'})
        self.assertEqual(children[0].returncode, 0)

    def test_disconnect_and_timeout_kill_child(self):
        for timeout in (False, True):
            with self.subTest(timeout=timeout):
                spawn, children = self.synthetic_process('import time; print(\'{"type":"reserve"}\', flush=True); time.sleep(60)')
                with patch.object(server.asyncio, 'create_subprocess_exec', spawn), patch.object(server, 'RUN_TIMEOUT', 0.2 if timeout else 10), TestClient(server.app) as client:
                    with client.websocket_connect('/run', headers={'Authorization': 'Bearer ' + TOKEN}) as socket:
                        socket.send_json({})
                        self.assertEqual(socket.receive_json(), {'type': 'reserve'})
                        if timeout:
                            self.assertEqual(socket.receive_json(), {'type': 'failure'})
                self.assertIsNotNone(children[0].returncode)

    def test_child_failure_cannot_claim_completion(self):
        spawn, children = self.synthetic_process('print(\'{"type":"complete"}\', flush=True); raise SystemExit(1)')
        with patch.object(server.asyncio, 'create_subprocess_exec', spawn), TestClient(server.app) as client:
            with client.websocket_connect('/run', headers={'Authorization': 'Bearer ' + TOKEN}) as socket:
                socket.send_json({})
                self.assertEqual(socket.receive_json(), {'type': 'failure'})
        self.assertEqual(children[0].returncode, 1)

if __name__ == '__main__':
    unittest.main()
