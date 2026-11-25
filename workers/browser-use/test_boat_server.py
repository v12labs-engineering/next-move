import hashlib
import hmac
import tempfile
import time
from datetime import datetime, timedelta, timezone
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch, AsyncMock, Mock
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import boat_server

TOKEN = 'synthetic-worker-token-at-least-32-characters'
@asynccontextmanager
async def no_browser(app):
    with patch.object(boat_server, 'sessions', {None: boat_server.BrowserSession()}), \
         patch.object(boat_server, 'closed_sessions', set()):
        boat_server.sessions[None].port = 9222
        yield

class BoatTests(unittest.TestCase):
    def test_auth_precedes_browser_and_file_access(self):
        with patch.dict('os.environ', {'BROWSER_USE_WORKER_TOKEN':TOKEN}), patch.object(boat_server.app.router, 'lifespan_context', no_browser), TestClient(boat_server.app) as client:
            self.assertEqual(client.get('/session').status_code,401)
            self.assertEqual(client.post('/files/resume.pdf',content=b'fake').status_code,401)
            self.assertEqual(client.post('/close').status_code,401)
            self.assertEqual(client.post('/captcha', json={}).status_code,401)
            with self.assertRaises(WebSocketDisconnect):
                with client.websocket_connect('/cdp'): pass

    def test_upload_limits_and_staging_path(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {'BROWSER_USE_WORKER_TOKEN':TOKEN}), patch.object(boat_server,'UPLOADS',Path(directory)), patch.object(boat_server.app.router, 'lifespan_context', no_browser), TestClient(boat_server.app) as client:
            headers={'Authorization':'Bearer '+TOKEN}
            result=client.post('/files/resume.pdf',content=b'fake-pdf',headers=headers)
            self.assertEqual(result.status_code,200)
            self.assertEqual(Path(directory,'resume.pdf').read_bytes(),b'fake-pdf')
            self.assertEqual(client.post('/files/bad%5Cname',content=b'x',headers=headers).status_code,400)
            self.assertEqual(client.post('/files/large.pdf',content=b'x'*2_000_001,headers=headers).status_code,413)
            self.assertFalse(Path(directory,'large.pdf').exists())

    def test_batch_sessions_use_distinct_credentials_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict('os.environ', {'BROWSER_USE_WORKER_TOKEN': TOKEN, 'BOAT_BATCH': '1'}), \
             patch.object(boat_server, 'ROOT', Path(directory, 'browser')), \
             patch.object(boat_server.BrowserSession, 'start', self.fake_browser), \
             TestClient(boat_server.app) as client:
            admin = {'Authorization': 'Bearer ' + TOKEN}
            expires = (datetime.now(timezone.utc) + timedelta(seconds=10)).isoformat()
            config = {'expiresAt': expires}
            first, second, third = [f'00000000-0000-4000-8000-00000000000{i}' for i in (1, 2, 3)]
            urls = [f'/sessions/{id}' for id in (first, second, third)]
            self.assertEqual(client.post(urls[0], json=config).status_code, 401)
            for url in urls[:2]:
                self.assertEqual(client.post(url, json=config, headers=admin).status_code, 200)
            self.assertEqual(client.post(urls[2], json=config, headers=admin).status_code, 409)
            first_headers, second_headers = map(self.session_headers, (first, second))
            self.assertEqual(client.get(urls[1] + '/session', headers=first_headers).status_code, 401)
            first_path = Path(client.post(urls[0] + '/files/resume.pdf', headers=first_headers,
                                          content=b'first').json()['path'])
            second_path = Path(client.post(urls[1] + '/files/resume.pdf', headers=second_headers,
                                           content=b'second').json()['path'])
            self.assertNotEqual(first_path, second_path)
            self.assertEqual(client.post(urls[0] + '/close', headers=first_headers).status_code, 200)
            self.assertFalse(first_path.exists())
            self.assertEqual(second_path.read_bytes(), b'second')
            self.assertEqual(client.post(urls[0], json=config, headers=admin).status_code, 410)
            self.assertEqual(client.post(urls[2], json=config, headers=admin).status_code, 200)

    def test_batch_session_expires_without_an_explicit_close(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict('os.environ', {'BROWSER_USE_WORKER_TOKEN': TOKEN, 'BOAT_BATCH': '1'}), \
             patch.object(boat_server, 'ROOT', Path(directory, 'browser')), \
             patch.object(boat_server.BrowserSession, 'start', self.fake_browser), \
             TestClient(boat_server.app) as client:
            id = '00000000-0000-4000-8000-000000000001'
            url = '/sessions/' + id
            expires = (datetime.now(timezone.utc) + timedelta(seconds=.1)).isoformat()
            response = client.post(url, json={'expiresAt': expires}, headers={'Authorization': 'Bearer ' + TOKEN})
            self.assertEqual(response.status_code, 200)
            headers = self.session_headers(id)
            for _ in range(50):
                time.sleep(.02)
                if client.get(url + '/session', headers=headers).status_code == 410:
                    break
            else:
                self.fail('Expired browser session was still accessible')
            self.assertFalse(Path(directory, 'browser-' + id).exists())

    @staticmethod
    async def fake_browser(current):
        current.uploads.mkdir(parents=True)
        current.port = 9222
        current.endpoint = 'ws://127.0.0.1:9222/devtools/browser/synthetic'
        current.chrome = current.recorder = Mock(returncode=0)

    @staticmethod
    def session_headers(id):
        token = hmac.new(TOKEN.encode(), id.encode(), hashlib.sha256).hexdigest()
        return {'Authorization': 'Bearer ' + token}

    def test_captcha_rejects_invalid_requests_before_spawning(self):
        with patch.dict('os.environ', {'BROWSER_USE_WORKER_TOKEN':TOKEN}), patch.object(boat_server.app.router, 'lifespan_context', no_browser), patch.object(boat_server.asyncio, 'create_subprocess_exec') as spawn, TestClient(boat_server.app) as client:
            headers={'Authorization':'Bearer '+TOKEN}
            for body in ('invalid', '[]', '{"pageId":"../x"}', '{"pageId":"ABC","timeoutMs":null}'):
                self.assertEqual(client.post('/captcha',content=body,headers=headers).status_code,400)
            self.assertEqual(client.post('/captcha',content='x'*4097,headers=headers).status_code,413)
            spawn.assert_not_called()

    def test_captcha_worker_result_and_timeout_cleanup(self):
        for timeout in (False, True):
            process = Mock(returncode=None if timeout else 0)
            process.communicate = AsyncMock(side_effect=TimeoutError() if timeout else None, return_value=(b'{"type":"result","result":{"solved":true}}\n', b''))
            process.wait = AsyncMock(return_value=0)
            with patch.dict('os.environ', {'BROWSER_USE_WORKER_TOKEN':TOKEN}), patch.object(boat_server.app.router, 'lifespan_context', no_browser), patch.object(boat_server.asyncio, 'create_subprocess_exec', AsyncMock(return_value=process)), TestClient(boat_server.app) as client:
                response = client.post('/captcha', json={'pageId':'ABC123','key':'synthetic-only','timeoutMs':1000}, headers={'Authorization':'Bearer '+TOKEN})
                self.assertEqual(response.status_code,200)
                self.assertEqual(response.json()['result'], None if timeout else {'solved':True})
                self.assertNotIn('synthetic-only', response.text)
                self.assertEqual(process.kill.call_count, 1 if timeout else 0)
                process.wait.assert_awaited_once()
