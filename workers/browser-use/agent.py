"""Browser Use agent. JSON-lines stdin/stdout is a private parent RPC channel."""
import asyncio
import json
import os
import re
import sys
import tempfile
import time
from contextlib import contextmanager
from urllib.parse import urlsplit

os.environ['ANONYMIZED_TELEMETRY'] = 'false'
os.environ['BROWSER_USE_LOGGING_LEVEL'] = 'critical'
# SDK diagnostics must never corrupt the protocol or expose candidate data.
protocol_out = sys.stdout
sys.stdout = sys.stderr


def emit(message):
    protocol_out.write(json.dumps(message) + '\n')
    protocol_out.flush()


async def rpc(message):
    emit(message)
    line = await asyncio.to_thread(sys.stdin.readline)
    if not line:
        raise RuntimeError('Parent disconnected')
    result = json.loads(line)
    if result.get('error'):
        raise RuntimeError('Application operation stopped')
    return result


class RunTiming:
    def __init__(self):
        self.started = time.monotonic()
        self.turn = 0

    def record(self, phase, started, ok=True):
        now = time.monotonic()
        # Only fixed phase names, counters and durations. Never inputs or results.
        emit({'type': 'progress', 'actions': [], 'timing': {
            'phase': phase, 'durationMs': round((now - started) * 1000),
            'elapsedMs': round((now - self.started) * 1000),
            'turn': self.turn, 'ok': ok}})

    @contextmanager
    def measure(self, phase):
        started = time.monotonic()
        ok = False
        try:
            yield
            ok = True
        finally:
            self.record(phase, started, ok)


async def main():
    timing = RunTiming()
    config = json.loads(sys.stdin.readline())
    with timing.measure('sdk_import'):
        from browser_use import Agent, Browser, Tools, ActionResult
        from browser_use.llm import ChatOpenAI

    class TimedChatOpenAI(ChatOpenAI):
        async def ainvoke(self, *args, **kwargs):
            with timing.measure('model'):
                return await super().ainvoke(*args, **kwargs)

    class TimedBrowser(Browser):
        async def get_browser_state_summary(self, *args, **kwargs):
            with timing.measure('dom_snapshot'):
                return await super().get_browser_state_summary(*args, **kwargs)

    browser = TimedBrowser(cdp_url=config['connectUrl'], keep_alive=True,
                      cross_origin_iframes=True, enable_default_extensions=False)
    terminal = False
    intent = False
    submission_clicked = False
    first_input = False

    async def tool_rpc(name, arguments):
        message = {'type': 'tool', 'name': name, 'arguments': arguments}
        # SDK-owned focus follows native switches/popups; the model does not
        # supply this target. Backend verification must inspect this same tab.
        if browser.agent_focus_target_id:
            message['pageId'] = browser.agent_focus_target_id
        return await rpc(message)

    async def begin_submission():
        nonlocal terminal, intent
        with timing.measure('begin_submission'):
            result = await tool_rpc('begin_submission', {})
        terminal = bool(result.get('done'))
        intent = bool(result.get('authorized')) or terminal
        return result

    class NativeTools(Tools):
        async def act(self, action, browser_session, **kwargs):
            nonlocal first_input
            with timing.measure('native_action'):
                result = await self.execute_native(action, browser_session, **kwargs)
            if not result.error and not first_input and set(action.model_dump(exclude_unset=True)) & {'input', 'select_dropdown', 'upload_file'}:
                first_input = True
                timing.record('first_input', timing.started)
            if result.error:
                emit({'type': 'progress', 'actions': list(action.model_dump(exclude_unset=True)), 'failed': True})
            return result

        async def execute_native(self, action, browser_session, **kwargs):
            nonlocal submission_clicked
            parameters = action.model_dump(exclude_unset=True)
            emit({'type': 'progress', 'actions': list(parameters)})
            # Generic navigation can open search even when the search tool is disabled.
            navigate = parameters.get('navigate')
            if navigate:
                try:
                    destination = urlsplit(navigate['url'])
                except ValueError:
                    return ActionResult(error='Invalid navigation URL')
                host = (destination.hostname or '').rstrip('.').removeprefix('www.')
                path = destination.path.rstrip('/').lower()
                if ((host in {'bing.com', 'google.com'} and path in {'', '/search'})
                        or (host in {'duckduckgo.com', 'html.duckduckgo.com', 'lite.duckduckgo.com'}
                            and path in {'', '/html', '/lite'})):
                    return ActionResult(error='Web search is disabled. Continue from the open job page and follow its Apply link if needed.')

            # Record intent before a native final-submit click even if the
            # planner omitted its explicit begin_submission tool call.
            click = parameters.get('click')
            if click and click.get('index') is not None:
                node = (await browser_session.get_selector_map()).get(click['index'])
                if node:
                    label = node.get_all_children_text().strip()
                    # Multi-page forms also use type=submit for navigation.
                    advancing = bool(re.fullmatch(r'(?:next(?: step| page)?|continue|save (?:and|&) continue|review(?: application)?)\s*[→>»]?', label, re.I))
                    verification = submission_clicked and bool(re.fullmatch(r'(?:verify|confirm)(?: (?:code|email|e-mail|phone|identity))?', label, re.I))
                    final = not advancing and not verification and (node.attributes.get('type', '').lower() == 'submit' or bool(re.fullmatch(r'(?:submit(?: application)?|send application)', label, re.I)))
                    if 'begin_submission' not in config['tools'] and (final or node.attributes.get('type', '').lower() == 'submit'):
                        return ActionResult(error='Read-only discovery cannot submit a form')
                    if final and submission_clicked:
                        return ActionResult(error='The application send was already attempted. Do not submit again. Inspect the receipt or use request_verification for a verification code.')
                    if final and not intent:
                        result = await begin_submission()
                        if terminal:
                            return ActionResult(extracted_content=json.dumps(result), is_done=True, success=True)
                    if final:
                        # A click can reach the employer before the SDK reports
                        # a navigation error. Fence retries before executing it.
                        submission_clicked = True
            return await super().act(action, browser_session, **kwargs)

    # Native DOM perception, clicking, typing, dropdowns, scrolling and uploads.
    tools = NativeTools(exclude_actions=['search', 'save_as_pdf'])

    from tool_models import TOOL_MODELS

    def register(name, model):
        async def action(params):
            nonlocal terminal
            if name == 'begin_submission':
                result = await begin_submission()
            else:
                with timing.measure(name):
                    result = await tool_rpc(name, params.model_dump())
            terminal = bool(result.get('done'))
            return ActionResult(extracted_content=json.dumps(result), is_done=terminal,
                                success=terminal and not result.get('toolError'))
        action.__name__ = name
        tools.action(config['tools'][name]['description'], param_model=model)(action)

    if not set(config['tools']).issubset(TOOL_MODELS):
        raise RuntimeError('Application tool contract changed')
    for name in config['tools']:
        register(name, TOOL_MODELS[name])

    async def reserve(_agent):
        timing.turn += 1
        with timing.measure('reserve_decision'):
            await rpc({'type': 'reserve'})

    model = TimedChatOpenAI(model=config['model']['modelId'],
                       base_url=config['model']['baseURL'], api_key=config['model']['apiKey'],
                       max_retries=0, timeout=60, frequency_penalty=None,
                       temperature=None, reasoning_effort=None)
    filling_policy = (
        'Fill each form page strictly top to bottom in visible field order, completing each field before moving down. '
        'Retrieve saved answers once before filling; fetch again only for a genuinely new question. '
        'Batch consecutive known fields using native actions, stopping when a dropdown or conditional field changes the page. '
        'Use the DOM state supplied each turn; do not run evaluate, scroll back, or re-read completed fields after each batch. '
        'Skip optional unknown fields. Do one consolidated final validation per page, then advance or submit promptly. '
        'Next, Continue and Review advance intermediate pages; call begin_submission only before the final application send. '
        'Use read-only evaluate only if supplied DOM state cannot resolve a specific control, or for that final validation. '
        'Repeat inspection only after a failed action, visible validation error, or changed dependent controls; inspect only the affected fields. '
        'Do not write scratch checklists for routine form filling. '
    ) if 'begin_submission' in config['tools'] else (
        'This is read-only discovery. Inspect questions without filling or submitting. '
    )
    with tempfile.TemporaryDirectory(prefix='application-agent-') as directory:
        agent = Agent(task=config['task'], llm=model, browser=browser, tools=tools,
                      use_vision=False, directly_open_url=False,
                      extend_system_message=(
                          'This is a DOM-only session: screenshots are unavailable. '
                          'Start from the saved job URL already open in Chrome. '
                          'Locate the form for this job before entering candidate data. '
                          'If the posting shows no application fields, click its Apply or Apply Now control. '
                          'After each click, check for a newly opened tab and switch to it if it belongs to this application. '
                          'Let the destination load, then inspect its fields or follow the next application entry control for the same job. '
                          'Use the tab with the actual application fields for all form work and receipt checks. '
                          'Stay within this posting and its application flow. '
                          'If the posting or form is unavailable, stop and report the blocker. '
                          'Do not search the web for the job or open another posting. '
                          + filling_policy +
                          'Do not navigate or reload a filled form just to inspect it. '
                          'Do not alter approved application documents. '
                          'Submit only with a native click after begin_submission, never with evaluate or keyboard shortcuts. '
                          'A passive reCAPTCHA badge is not an active challenge.'),
                      max_actions_per_step=8, max_failures=3,
                      available_file_paths=config.get('files', []),
                      use_judge=False, calculate_cost=False, enable_planning=False,
                      step_timeout=240, llm_timeout=60, file_system_path=directory)
        timing.record('agent_ready', timing.started)
        try:
            if config.get('pageId'):
                with timing.measure('browser_connect'):
                    await browser.start()
                    await browser.get_or_create_cdp_session(config['pageId'], focus=True)
            with timing.measure('agent_run'):
                await agent.run(max_steps=60, on_step_start=reserve)
            if not terminal:
                raise RuntimeError('Application did not reach a backend checkpoint')
            emit({'type': 'complete'})
        finally:
            # keep_alive preserves the browser for the backend submission gate.
            await browser.stop()


def failure_event(error):
    # Never include Pydantic inputs, messages or context: those can contain secrets.
    import traceback
    from pydantic import ValidationError
    frames = traceback.extract_tb(error.__traceback__)
    frame = frames[-1] if frames else None
    details = {'type': 'failure', 'code': type(error).__name__}
    if frame:
        details['location'] = f'{os.path.basename(frame.filename)}:{frame.lineno}'
    if isinstance(error, ValidationError):
        details['validation'] = [{'path': '.'.join(map(str, item['loc'])), 'code': item['type']}
                                 for item in error.errors(include_input=False, include_context=False, include_url=False)[:5]]
    return details


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except BaseException as error:
        emit(failure_event(error))
        sys.exit(1)
