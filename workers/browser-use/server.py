"""One authenticated WebSocket owns one isolated Browser Use subprocess."""
import asyncio
import contextlib
import hmac
import json
import os
import sys
import tempfile
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from anyio import CancelScope

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
MAX_MESSAGE = 2_000_000
RUN_TIMEOUT = 720
capacity = asyncio.Semaphore(int(os.environ.get('BROWSER_USE_CONCURRENCY', '4')))


@app.get('/healthz')
async def health():
    return {'status': 'ok', 'service': 'browser-use-worker'}


async def receive(socket):
    message = await socket.receive()
    if message['type'] == 'websocket.disconnect':
        raise WebSocketDisconnect(message.get('code', 1000))
    text = message.get('text')
    if text is None:
        raise ValueError('Text frame required')
    if len(text.encode()) > MAX_MESSAGE:
        raise ValueError('Message too large')
    # Re-encode so a multiline message cannot inject extra stdin protocol events.
    return json.dumps(json.loads(text)).encode() + b'\n'


@app.websocket('/run')
async def run(socket: WebSocket):
    token = os.environ.get('BROWSER_USE_WORKER_TOKEN', '')
    if len(token) < 32 or not hmac.compare_digest(
        socket.headers.get('authorization', ''), 'Bearer ' + token
    ):
        await socket.close(code=1008)
        return
    if capacity.locked():
        await socket.close(code=1013)
        return
    async with capacity:
        await execute(socket)


async def execute(socket, connect_url=None):
    await socket.accept()
    process = None
    tasks = []
    with tempfile.TemporaryDirectory(prefix='application-worker-') as directory:
        try:
            async with asyncio.timeout(RUN_TIMEOUT):
                initial = await receive(socket)
                if connect_url:
                    config = json.loads(initial)
                    config['connectUrl'] = connect_url
                    initial = json.dumps(config).encode() + b'\n'

                process = await asyncio.create_subprocess_exec(
                    sys.executable, str(Path(__file__).with_name('agent.py')),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL, limit=MAX_MESSAGE,
                    env={**{key: value for key, value in os.environ.items()
                            if key in ('PATH', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR')},
                         'HOME': directory, 'TMPDIR': directory,
                         'PYTHONPATH': os.pathsep.join(sys.path)},
                )
                process.stdin.write(initial)
                await process.stdin.drain()

                async def replies():
                    while True:
                        process.stdin.write(await receive(socket))
                        await process.stdin.drain()

                async def events():
                    complete = False
                    while line := await process.stdout.readline():
                        if len(line) > MAX_MESSAGE:
                            raise ValueError('Message too large')
                        event = json.loads(line)
                        # Only report completion once the child exits successfully.
                        if event.get('type') == 'complete':
                            complete = True
                        else:
                            await socket.send_json(event)
                    code = await process.wait()
                    await socket.send_json({'type': 'complete' if complete and code == 0 else 'failure'})

                tasks = [asyncio.create_task(replies()), asyncio.create_task(events())]
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
        except WebSocketDisconnect:
            pass
        except (TimeoutError, ValueError, OSError, RuntimeError):
            with contextlib.suppress(Exception):
                await socket.send_json({'type': 'failure'})
        finally:
            with CancelScope(shield=True):
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                if process:
                    if process.returncode is None:
                        with contextlib.suppress(ProcessLookupError):
                            process.kill()
                    await process.wait()
                with contextlib.suppress(Exception):
                    await socket.close()
