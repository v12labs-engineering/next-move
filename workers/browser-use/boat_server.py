"""Authenticated Boat gateway with a separate Chrome process per attempt."""
import asyncio
import contextlib
import hmac
import json
import os
import re
import shutil
import signal
import time
from datetime import datetime

import httpx
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request, HTTPException, WebSocket
from websockets.asyncio.client import connect
from server import execute, health

ROOT = Path('/tmp/application-browser')
UPLOADS = Path('/tmp/.uploads')
SESSION_ID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
sessions = {}
closed_sessions = set()


def worker_environment():
    return {key: value for key, value in os.environ.items()
            if key not in ('BROWSER_USE_WORKER_TOKEN', 'BOAT_BATCH')}


def authorized(headers, session_id=None):
    token = os.environ.get('BROWSER_USE_WORKER_TOKEN', '')
    if len(token) < 32:
        return False
    if session_id is not None:
        token = hmac.digest(token.encode(), session_id.encode(), 'sha256').hex()
    return hmac.compare_digest(headers.get('authorization', ''), 'Bearer ' + token)


async def stop_process(process, sig=signal.SIGTERM):
    if process is not None and process.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            process.send_signal(sig)
        try:
            await asyncio.wait_for(process.wait(), 4)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()


class BrowserSession:
    def __init__(self, session_id=None):
        self.session_id = session_id
        self.root = ROOT if session_id is None else Path(f'{ROOT}-{session_id}')
        self.uploads = UPLOADS if session_id is None else self.root / 'uploads'
        self.profile = self.root / 'profile'
        self.display = self.chrome = self.recorder = None
        self.port = None
        self.endpoint = None
        self.timer = self.starting = self.closing = self.agent = None
        self.operations = set()

    async def start(self):
        self.profile.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.root.chmod(0o700)
        self.uploads.mkdir(mode=0o700, exist_ok=True)
        env = worker_environment()
        display = ':0'
        async with asyncio.timeout(12):
            if self.session_id is not None:
                self.display = await asyncio.create_subprocess_exec(
                    'Xvfb', '-displayfd', '1', '-screen', '0', '1280x900x24',
                    '-nolisten', 'tcp', stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL, env=env)
                number = (await self.display.stdout.readline()).strip()
                if not number.isdigit():
                    raise RuntimeError('Virtual display did not start')
                display = ':' + number.decode('ascii')
            # Keep the original debug port for the standalone diagnostic scripts.
            port = '9222' if self.session_id is None else '0'
            self.chrome = await asyncio.create_subprocess_exec(
                '/usr/bin/google-chrome', '--no-sandbox', '--no-first-run',
                '--no-default-browser-check', '--disable-dev-shm-usage',
                '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
                '--user-data-dir=' + str(self.profile), '--window-size=1280,900', 'about:blank',
                env={**env, 'DISPLAY': display},
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            if self.session_id is None:
                async with httpx.AsyncClient() as client:
                    while True:
                        try:
                            response = await client.get('http://127.0.0.1:9222/json/version', timeout=2)
                            response.raise_for_status()
                            self.endpoint = response.json()['webSocketDebuggerUrl']
                            self.port = 9222
                            break
                        except (httpx.HTTPError, KeyError):
                            await asyncio.sleep(.1)
            else:
                debugger = self.profile / 'DevToolsActivePort'
                while True:
                    try:
                        port, path = debugger.read_text().splitlines()
                        self.port = int(port)
                        self.endpoint = f'ws://127.0.0.1:{self.port}{path}'
                        break
                    except (FileNotFoundError, ValueError):
                        await asyncio.sleep(.1)
            recording = Path('/home/user/application-recording.mp4')
            if self.session_id is not None:
                directory = recording.parent / 'application-recordings'
                directory.mkdir(mode=0o700, exist_ok=True)
                recording = directory / f'{self.session_id}.mp4'
            self.recorder = await asyncio.create_subprocess_exec(
                'ffmpeg', '-y', '-f', 'x11grab', '-framerate', '10', '-i', display,
                '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                '-movflags', '+frag_keyframe+empty_moov', str(recording), env=env,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)

    def status(self):
        return {'ready': self.chrome is not None and self.chrome.returncode is None and self.endpoint is not None,
                'recording': self.recorder is not None and self.recorder.returncode is None}

    @contextlib.contextmanager
    def operation(self):
        task = asyncio.current_task()
        self.operations.add(task)
        try:
            yield
        finally:
            self.operations.discard(task)

    async def expire(self, seconds):
        await asyncio.sleep(seconds)
        await self.close()

    async def close(self):
        if self.closing is None:
            self.closing = asyncio.create_task(self.finish())
        await asyncio.shield(self.closing)

    async def finish(self):
        if self.timer:
            self.timer.cancel()
        if self.starting:
            await asyncio.gather(self.starting, return_exceptions=True)
        operations = list(self.operations)
        for operation in operations:
            operation.cancel()
        if operations:
            await asyncio.wait(operations, timeout=3)
        await asyncio.gather(stop_process(self.recorder, signal.SIGINT), stop_process(self.chrome))
        await stop_process(self.display)
        shutil.rmtree(self.root, ignore_errors=True)
        if self.session_id is None:
            shutil.rmtree(self.uploads, ignore_errors=True)
        sessions.pop(self.session_id, None)
        closed_sessions.add(self.session_id)


@contextlib.asynccontextmanager
async def lifespan(_app):
    closed_sessions.clear()
    try:
        if os.environ.get('BOAT_BATCH') != '1':
            legacy = sessions[None] = BrowserSession()
            legacy.starting = asyncio.create_task(legacy.start())
            await legacy.starting
        yield
    finally:
        await asyncio.gather(*(session.close() for session in list(sessions.values())))


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.get('/healthz')(health)
routes = APIRouter()


@app.post('/sessions/{session_id}')
async def open_session(session_id: str, request: Request):
    if not authorized(request.headers):
        raise HTTPException(401)
    if os.environ.get('BOAT_BATCH') != '1' or not SESSION_ID.fullmatch(session_id):
        raise HTTPException(404)
    try:
        expires_at = datetime.fromisoformat((await request.json())['expiresAt']).timestamp()
        seconds = expires_at - time.time()
        if not 0 < seconds <= 815:
            raise ValueError()
    except (ValueError, KeyError, TypeError, OverflowError):
        raise HTTPException(422)
    if session_id in closed_sessions:
        raise HTTPException(410)
    current = sessions.get(session_id)
    if current is None:
        if len(sessions) >= 2:
            raise HTTPException(409)
        current = sessions[session_id] = BrowserSession(session_id)
        current.starting = asyncio.create_task(current.start())
        current.timer = asyncio.create_task(current.expire(seconds))
    try:
        await asyncio.shield(current.starting)
    except (OSError, TimeoutError, RuntimeError):
        await current.close()
        raise HTTPException(500, 'Chrome could not start')
    if current.closing:
        raise HTTPException(410)
    return current.status()


def request_session(connection):
    session_id = connection.path_params.get('session_id')
    if not authorized(connection.headers, session_id):
        raise HTTPException(401)
    current = sessions.get(session_id)
    if current is None or current.closing:
        raise HTTPException(410)
    return current


@routes.get('/session')
async def session(request: Request):
    return request_session(request).status()


@routes.post('/files/{name}')
async def upload(name: str, request: Request):
    current = request_session(request)
    if not 1 <= len(name) <= 180 or name in ('.', '..') or any(c in name for c in ('/', '\\', '\x00')):
        raise HTTPException(400)
    with current.operation():
        content = bytearray()
        async for chunk in request.stream():
            content.extend(chunk)
            if len(content) > 2_000_000:
                raise HTTPException(413)
        path = current.uploads / name
        path.write_bytes(content)
        path.chmod(0o600)
        return {'path': str(path)}


@routes.post('/close')
async def close(request: Request):
    session_id = request.path_params.get('session_id')
    if not authorized(request.headers, session_id):
        raise HTTPException(401)
    current = sessions.get(session_id)
    if current:
        await current.close()
    else:
        closed_sessions.add(session_id)
    return {'closed': True}


@routes.websocket('/run')
async def run(socket: WebSocket):
    try:
        current = request_session(socket)
        if not current.endpoint or current.agent is not None:
            await socket.close(code=1013)
            return
    except HTTPException:
        await socket.close(code=1008)
        return
    current.agent = asyncio.current_task()
    try:
        with current.operation():
            await execute(socket, current.endpoint)
    finally:
        current.agent = None


@routes.websocket('/cdp')
async def cdp(socket: WebSocket):
    try:
        current = request_session(socket)
        if not current.endpoint:
            await socket.close(code=1013)
            return
    except HTTPException:
        await socket.close(code=1008)
        return
    with current.operation():
        await socket.accept()
        tasks = []
        try:
            async with connect(current.endpoint, max_size=32_000_000) as remote:
                async def incoming():
                    while True:
                        await remote.send(await socket.receive_text())

                async def outgoing():
                    async for message in remote:
                        await socket.send_text(message)

                tasks = [asyncio.create_task(incoming()), asyncio.create_task(outgoing())]
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            with contextlib.suppress(Exception):
                await socket.close()


@routes.post('/captcha')
async def captcha(request: Request):
    current = request_session(request)
    with current.operation():
        return await solve_captcha(request, current)


async def solve_captcha(request, current):
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 4096:
            raise HTTPException(413)
    try:
        config = json.loads(body)
        if not isinstance(config, dict):
            raise ValueError()
        timeout = min(260, max(1, int(config.get('timeoutMs', 0)) / 1000))
    except (ValueError, TypeError):
        raise HTTPException(400)
    if not isinstance(config.get('pageId'), str) or not re.fullmatch(r'[A-Za-z0-9]+', config['pageId']):
        raise HTTPException(400)
    config['port'] = current.port
    process = await asyncio.create_subprocess_exec(
        'node', str(Path(__file__).with_name('captcha-worker.mjs')),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, env=worker_environment())
    try:
        async with asyncio.timeout(timeout + 5):
            output, _ = await process.communicate(json.dumps(config).encode() + b'\n')
            events = [json.loads(line) for line in output.splitlines()]
            result = next((e['result'] for e in events if e.get('type') == 'result'), None)
            return {'result': result if process.returncode == 0 else None,
                    'logs': [e for e in events if e.get('type') == 'log'][-300:]}
    except (TimeoutError, ValueError):
        return {'result': None, 'logs': []}
    finally:
        if process.returncode is None:
            process.kill()
        await process.wait()


app.include_router(routes)
app.include_router(routes, prefix='/sessions/{session_id}')
