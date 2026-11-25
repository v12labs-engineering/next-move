import asyncio
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

# The actual installed SDK validates our tool schema and invokes the RPC action.
from browser_use import Agent, Browser
from tool_models import TOOL_MODELS

spec = importlib.util.spec_from_file_location('application_agent', Path(__file__).with_name('agent.py'))
agent_module = importlib.util.module_from_spec(spec)
original_stdout = sys.stdout
spec.loader.exec_module(agent_module)
sys.stdout = original_stdout


class AgentTests(unittest.TestCase):
    def test_business_tools_report_current_agent_focus_after_tab_switch(self):
        config = {'connectUrl': 'http://127.0.0.1:1', 'task': 'Synthetic',
                  'tools': {'solve_captcha': {'description': 'Solve challenge'}, 'begin_submission': {'description': 'Record intent'}},
                  'model': {'modelId': 'fixture', 'baseURL': 'http://127.0.0.1:2', 'apiKey': 'fictional'}}
        stream = io.StringIO(json.dumps(config) + '\n' + json.dumps({'solved': False}) + '\n' + json.dumps({'solved': True}) + '\n' + json.dumps({'done': True}) + '\n')
        output = io.StringIO()
        async def run(real_agent, **kwargs):
            real_agent.browser_session.agent_focus_target_id = 'original-tab'
            await real_agent.tools.registry.execute_action('solve_captcha', {})
            real_agent.browser_session.agent_focus_target_id = 'employer-popup'
            await real_agent.tools.registry.execute_action('solve_captcha', {})
            await real_agent.tools.registry.execute_action('begin_submission', {})
        async def stop(_browser):
            pass
        with patch.object(sys, 'stdin', stream), patch.object(agent_module, 'protocol_out', output), patch.object(Agent, 'run', run), patch.object(Browser, 'stop', stop):
            asyncio.run(agent_module.main())
        tools = [json.loads(line) for line in output.getvalue().splitlines() if json.loads(line)['type'] == 'tool']
        self.assertEqual([tool.get('pageId') for tool in tools], ['original-tab', 'employer-popup', 'employer-popup'])

    def test_validation_diagnostic_excludes_input_and_context(self):
        from pydantic import BaseModel, Field, ValidationError
        class Task(BaseModel):
            task: str = Field(max_length=5)
        try:
            Task(task='private-resume-and-credential')
        except ValidationError as error:
            event = agent_module.failure_event(error)
        self.assertEqual(event['validation'], [{'path': 'task', 'code': 'string_too_long'}])
        self.assertNotIn('private-resume', json.dumps(event))
        self.assertNotIn('input', json.dumps(event))
        self.assertNotIn('ctx', json.dumps(event))

    def test_native_browser_tools_and_parent_checkpoint(self):
        config = {'connectUrl': 'http://127.0.0.1:1', 'task': 'Synthetic test', 'tools': {name: {'description': name} for name in TOOL_MODELS},
                  'model': {'modelId': 'claude-sonnet-4.5', 'baseURL': 'http://127.0.0.1:2', 'apiKey': 'fictional'}}
        stream = io.StringIO(json.dumps(config) + '\n' + json.dumps({'ok': True}) + '\n' + json.dumps({'done': True}) + '\n')
        output = io.StringIO()

        async def run(real_agent, **kwargs):
            self.assertEqual(kwargs["max_steps"], 60)
            self.assertEqual(real_agent.settings.max_actions_per_step, 8)
            self.assertIn("strictly top to bottom", real_agent.settings.extend_system_message)
            names = set(real_agent.tools.registry.registry.actions)
            self.assertTrue(set(TOOL_MODELS).issubset(names))
            self.assertTrue({'click', 'input', 'scroll', 'upload_file', 'navigate', 'evaluate', 'write_file', 'read_file', 'replace_file'}.issubset(names))
            self.assertFalse({'fill', 'review', 'advance', 'ready'}.intersection(names))
            self.assertFalse(real_agent.settings.use_vision)
            # Telegram allows three minutes for a code, plus bridge/DOM work.
            self.assertGreaterEqual(real_agent.settings.step_timeout, 240)
            await kwargs['on_step_start'](real_agent)
            result = await real_agent.tools.registry.execute_action('begin_submission', {})
            self.assertTrue(result.is_done)

        async def stop(_browser):
            pass

        with patch.object(sys, 'stdin', stream), patch.object(agent_module, 'protocol_out', output), patch.object(Agent, 'run', run), patch.object(Browser, 'stop', stop):
            asyncio.run(agent_module.main())
        messages = [json.loads(line) for line in output.getvalue().splitlines() if 'timing' not in json.loads(line)]
        self.assertEqual([m['type'] for m in messages], ['reserve', 'tool', 'complete'])
        self.assertEqual(messages[1]['name'], 'begin_submission')

    def test_native_submit_click_records_intent_before_action(self):
        from types import SimpleNamespace
        from browser_use import Tools
        config = {'connectUrl': 'http://127.0.0.1:1', 'task': 'Synthetic',
                  'tools': {'begin_submission': {'description': 'Record intent'}},
                  'model': {'modelId': 'fixture', 'baseURL': 'http://127.0.0.1:2', 'apiKey': 'fictional'}}
        stream = io.StringIO(json.dumps(config) + '\n' + json.dumps({'done': True}) + '\n')
        output = io.StringIO()
        async def run(real_agent, **kwargs):
            async def selector_map():
                return {7: SimpleNamespace(attributes={'type': 'submit'}, get_all_children_text=lambda: 'Submit application')}
            action = SimpleNamespace(model_dump=lambda **kw: {'click': {'index': 7}})
            result = await real_agent.tools.act(action, SimpleNamespace(get_selector_map=selector_map))
            self.assertTrue(result.is_done)
        async def stop(_browser):
            pass
        async def native_action(*args, **kwargs):
            self.fail('Pre-submit test checkpoint must stop before native click')
        with patch.object(sys, 'stdin', stream), patch.object(agent_module, 'protocol_out', output), patch.object(Agent, 'run', run), patch.object(Browser, 'stop', stop), patch.object(Tools, 'act', native_action):
            asyncio.run(agent_module.main())
        events = [json.loads(line) for line in output.getvalue().splitlines() if 'timing' not in json.loads(line)]
        self.assertEqual([e['type'] for e in events], ['progress', 'tool', 'complete'])
        self.assertEqual(events[1]['name'], 'begin_submission')

    def test_native_navigation_cannot_search_for_the_open_job(self):
        from browser_use import ActionResult, Tools
        config = {'connectUrl': 'http://127.0.0.1:1', 'task': 'Apply to Synthetic Engineer',
                  'tools': {'begin_submission': {'description': 'Record intent'}},
                  'model': {'modelId': 'fixture', 'baseURL': 'http://127.0.0.1:2', 'apiKey': 'fictional'}}
        employer_url = 'https://careers.example.org/search?opening=123'
        navigated = []

        async def native_action(_tools, action, _browser, **kwargs):
            navigated.append(action.model_dump()['navigate']['url'])
            return ActionResult(extracted_content='Navigated')

        async def run(real_agent, **kwargs):
            self.assertNotIn('search', real_agent.tools.registry.registry.actions)
            for url in [
                'https://www.bing.com/search?q=Synthetic+Engineer',
                'https://www.google.com/search?q=Synthetic+Engineer',
                'https://duckduckgo.com/?q=Synthetic+Engineer',
            ]:
                with self.subTest(url=url):
                    action = real_agent.ActionModel(navigate={'url': url, 'new_tab': True})
                    result = await real_agent.tools.act(action, real_agent.browser_session)
                    self.assertIsNotNone(result.error)
            action = real_agent.ActionModel(navigate={'url': employer_url})
            result = await real_agent.tools.act(action, real_agent.browser_session)
            self.assertIsNone(result.error)
            await real_agent.tools.registry.execute_action('begin_submission', {})

        async def stop(_browser):
            pass

        stream = io.StringIO(json.dumps(config) + '\n' + json.dumps({'done': True}) + '\n')
        with patch.object(sys, 'stdin', stream), patch.object(agent_module, 'protocol_out', io.StringIO()), patch.object(Agent, 'run', run), patch.object(Browser, 'stop', stop), patch.object(Tools, 'act', native_action):
            asyncio.run(agent_module.main())
        self.assertEqual(navigated, [employer_url])

    def test_intermediate_submit_buttons_do_not_record_send_intent(self):
        from types import SimpleNamespace
        from browser_use import Tools, ActionResult
        config = {'connectUrl': 'http://127.0.0.1:1', 'task': 'Synthetic',
                  'tools': {'begin_submission': {'description': 'Record intent'}},
                  'model': {'modelId': 'fixture', 'baseURL': 'http://127.0.0.1:2', 'apiKey': 'fictional'}}
        for label in ['Next', 'Continue', 'Save and continue', 'Review application']:
            with self.subTest(label=label):
                async def run(real_agent, **kwargs):
                    async def selector_map():
                        return {7: SimpleNamespace(attributes={'type': 'submit'}, get_all_children_text=lambda: label)}
                    action = SimpleNamespace(model_dump=lambda **kw: {'click': {'index': 7}})
                    result = await real_agent.tools.act(action, SimpleNamespace(get_selector_map=selector_map))
                    self.assertIsNone(result.error)
                    self.assertFalse(result.is_done, "Intermediate page incorrectly recorded send intent")
                    # Complete the test at a business checkpoint after advancing.
                    await real_agent.tools.registry.execute_action('begin_submission', {})
                async def stop(_browser):
                    pass
                clicks = []
                async def native_action(*args, **kwargs):
                    clicks.append(label)
                    return ActionResult(extracted_content='Advanced to next page')
                output = io.StringIO()
                stream = io.StringIO(json.dumps(config) + '\n' + json.dumps({'done': True}) + '\n')
                with patch.object(sys, 'stdin', stream), patch.object(agent_module, 'protocol_out', output), patch.object(Agent, 'run', run), patch.object(Browser, 'stop', stop), patch.object(Tools, 'act', native_action):
                    asyncio.run(agent_module.main())
                self.assertEqual(clicks, [label], 'Intermediate page must advance before send intent')

    def test_timing_reports_success_and_failure_without_private_data(self):
        output = io.StringIO()
        with patch.object(agent_module, 'protocol_out', output):
            timing = agent_module.RunTiming()
            with timing.measure('model'):
                pass
            with self.assertRaises(ValueError):
                with timing.measure('reserve_decision'):
                    raise ValueError('private-answer-and-secret')
        events = [json.loads(line)['timing'] for line in output.getvalue().splitlines()]
        self.assertEqual([event['ok'] for event in events], [True, False])
        self.assertTrue(all(event['durationMs'] >= 0 for event in events))
        self.assertNotIn('private-answer', output.getvalue())

    def test_final_send_is_not_repeated_but_verification_remains_available(self):
        from types import SimpleNamespace
        from browser_use import Tools, ActionResult
        config = {'connectUrl': 'http://127.0.0.1:1', 'task': 'Synthetic',
                  'tools': {'begin_submission': {'description': 'Record intent'},
                            'report_submission': {'description': 'Report receipt'}},
                  'model': {'modelId': 'fixture', 'baseURL': 'http://127.0.0.1:2', 'apiKey': 'fictional'}}
        # A native click error may happen after the server received the send.
        for click_failed in [False, True]:
            with self.subTest(click_failed=click_failed):
                clicks = []
                label = 'Submit application'
                async def native_action(*args, **kwargs):
                    clicks.append(label)
                    return ActionResult(error='Navigation interrupted' if click_failed else None)
                async def run(real_agent, **kwargs):
                    nonlocal label
                    async def selector_map():
                        return {7: SimpleNamespace(attributes={'type': 'submit'}, get_all_children_text=lambda: label)}
                    action = SimpleNamespace(model_dump=lambda **kw: {'click': {'index': 7}})
                    browser = SimpleNamespace(get_selector_map=selector_map)
                    await real_agent.tools.act(action, browser)
                    duplicate = await real_agent.tools.act(action, browser)
                    self.assertIsNotNone(duplicate.error)
                    self.assertEqual(clicks, ['Submit application'])
                    for label in ['Verify', 'Verify code', 'Confirm email']:
                        await real_agent.tools.act(action, browser)
                    self.assertEqual(len(clicks), 4)
                    await real_agent.tools.registry.execute_action('report_submission', {'text': 'Your application was received.'})
                async def stop(_browser):
                    pass
                stream = io.StringIO(json.dumps(config) + '\n' + json.dumps({'authorized': True}) + '\n' + json.dumps({'done': True}) + '\n')
                with patch.object(sys, 'stdin', stream), patch.object(agent_module, 'protocol_out', io.StringIO()), patch.object(Agent, 'run', run), patch.object(Browser, 'stop', stop), patch.object(Tools, 'act', native_action):
                    asyncio.run(agent_module.main())

    def test_discovery_does_not_receive_filling_instructions(self):
        config = {'connectUrl': 'http://127.0.0.1:1', 'task': 'Read-only discovery',
                  'tools': {'report_form': {'description': 'Report questions'}},
                  'model': {'modelId': 'fixture', 'baseURL': 'http://127.0.0.1:2', 'apiKey': 'fictional'}}
        async def run(real_agent, **kwargs):
            self.assertIn('read-only discovery', real_agent.settings.extend_system_message)
            self.assertNotIn('Fill each form', real_agent.settings.extend_system_message)
        async def stop(_browser):
            pass
        with patch.object(sys, 'stdin', io.StringIO(json.dumps(config) + '\n')), patch.object(agent_module, 'protocol_out', io.StringIO()), patch.object(Agent, 'run', run), patch.object(Browser, 'stop', stop):
            with self.assertRaisesRegex(RuntimeError, 'backend checkpoint'):
                asyncio.run(agent_module.main())

    def test_agent_claim_alone_is_not_completion(self):
        config = {'connectUrl': 'http://127.0.0.1:1', 'task': 'Synthetic test', 'tools': {name: {'description': name} for name in TOOL_MODELS},
                  'model': {'modelId': 'claude-sonnet-4.5', 'baseURL': 'http://127.0.0.1:2', 'apiKey': 'fictional'}}
        async def run(*_args, **_kwargs):
            return 'success'
        async def stop(_browser):
            pass
        with patch.object(sys, 'stdin', io.StringIO(json.dumps(config) + '\n')), patch.object(Agent, 'run', run), patch.object(Browser, 'stop', stop):
            with self.assertRaisesRegex(RuntimeError, 'backend checkpoint'):
                asyncio.run(agent_module.main())

if __name__ == '__main__':
    unittest.main()
