"""Browser Use pilot: fill-only by default; reviewed submission requires explicit opt-in."""
import asyncio, json, os, sys, time, re, hashlib
from pathlib import Path
from urllib.parse import urlsplit
os.environ.setdefault('ANONYMIZED_TELEMETRY', 'false')
from browser_use import Agent, Browser, Tools, ActionResult
from browser_use.llm import ChatOpenAI
from playwright.async_api import async_playwright

BASE = Path('.local-data/browser-use-trial')
GUARD = r"""(() => {
 window.__fillOnlyBlocked = 0;
 window.__submissionEnabled=false;
 const stop = e => {if(window.__submissionEnabled)return; window.__fillOnlyBlocked++; e.preventDefault(); e.stopImmediatePropagation()};
 document.addEventListener('submit', stop, true);
 document.addEventListener('click', e => {const b=e.target.closest?.('button,input[type=submit],a'); if(b && /submit|send application|complete application/i.test(b.textContent+' '+b.value)) stop(e)}, true);
 const originalSubmit=HTMLFormElement.prototype.submit;
 HTMLFormElement.prototype.submit = function(){if(window.__submissionEnabled)return originalSubmit.call(this);window.__fillOnlyBlocked++};
 const originalRequestSubmit=HTMLFormElement.prototype.requestSubmit;
 HTMLFormElement.prototype.requestSubmit = function(...args){if(window.__submissionEnabled)return originalRequestSubmit.apply(this,args);window.__fillOnlyBlocked++};
})()"""
FIXTURE = '''<!doctype html><html><body><h1>Synthetic application</h1><iframe title="Application" style="width:100%;height:900px" src="https://browser-use-trial.invalid/form"></iframe></body></html>'''
FORM = '''<html><body><form action="/submit" method="post">
<label>Name <input name="name" required></label><br><label>Email <input name="email" type="email" required></label><br>
<fieldset><legend>Phone</legend><label>Country <select name="country" required><option value="">Select</option><option value="IN">India (+91)</option><option value="US">United States (+1)</option></select></label><label>Number <input name="phone" required></label></fieldset>
<label>Location <input id="location" role="combobox" aria-expanded="false" autocomplete="off"></label><div id="options" role="listbox"></div><div id="selected"></div><input name="city" type="hidden">
<label>Work authorized? <select name="authorized" required><option value="">Select</option><option>Yes</option><option>No</option></select></label><br>
<label>Resume <input type="file" name="resume" id="resume" required></label><br><button type="submit">Submit application</button></form>
<script>locationInput=document.querySelector('#location');locationInput.oninput=()=>setTimeout(()=>{document.querySelector('#options').innerHTML='<button type="button" role="option">Hyderabad, Telangana, India</button>';locationInput.setAttribute('aria-expanded','true');document.querySelector('#options [role=option]').onclick=()=>{document.querySelector('[name=city]').value='Hyderabad, Telangana, India';document.querySelector('#selected').textContent='Hyderabad, Telangana, India';locationInput.value='';document.querySelector('#options').innerHTML='';locationInput.setAttribute('aria-expanded','false')}},500)</script></body></html>'''

async def main(mode):
    assert mode in ('synthetic','prenuvo','prenuvo-submit')
    if mode=='prenuvo-submit': assert os.environ.get('PRENUVO_SUBMISSION_AUTHORIZED')=='true'
    session=json.loads((BASE/'session.json').read_text())
    started=time.monotonic(); blocked=[]; uploads=[]; upload_window={'until':0}; sending={'enabled':False,'requests':0,'verificationPending':False}; report={'mode':mode,'sessionId':session['id'],'submissionAllowed':False}
    async with async_playwright() as pw:
        remote=await pw.chromium.connect_over_cdp(session['connectUrl'])
        context=remote.contexts[0]
        await context.add_init_script(GUARD)
        async def route(r):
            req=r.request; u=urlsplit(req.url)
            if req.is_navigation_request() and req.frame.parent_frame is None and u.hostname not in ('browser-use-trial.invalid','app.careerpuck.com','job-boards.greenhouse.io'):
                await r.abort('blockedbyclient'); return
            if u.hostname=='browser-use-trial.invalid' and req.method=='GET':
                await r.fulfill(body=FORM if u.path=='/form' else FIXTURE,content_type='text/html'); return
            if (req.method=='POST' and u.hostname=='grnhse-prod-jben-us-east-1.s3.amazonaws.com' and u.path=='/' and 'multipart/form-data' in req.headers.get('content-type','') and urlsplit(req.frame.url).hostname=='job-boards.greenhouse.io' and time.monotonic()<upload_window['until']):
                upload_window['until']=0
                uploads.append({'host':u.hostname,'path':u.path,'purpose':'approved-resume-only'})
                await r.continue_(); return
            if sending['enabled'] and req.method=='POST':
                if u.hostname in ('www.recaptcha.net','recaptcha.net','www.google.com') and '/recaptcha/' in u.path:
                    await r.continue_(); return
                if u.hostname=='boards.greenhouse.io' and u.path=='/embed/prenuvo/jobs/4742463005' and sending['verificationPending']:
                    permit_path=BASE/'telegram-verification-permit.json'
                    if permit_path.exists():
                        permit=json.loads(permit_path.read_text())
                        try: payload=json.loads(req.post_data or '{}')
                        except Exception: payload={}
                        def code_matches(value):
                            if isinstance(value,dict):
                                return any(('code' in str(k).lower() and isinstance(v,str) and hashlib.sha256(v.upper().encode()).hexdigest()==permit.get('codeHash')) or code_matches(v) for k,v in value.items())
                            if isinstance(value,list): return any(code_matches(v) for v in value)
                            return False
                        if permit.get('sessionId')==session['id'] and time.time()<permit.get('expiresAt',0) and code_matches(payload):
                            permit_path.unlink(); sending['verificationPending']=False
                            report['telegramVerificationRequests']=report.get('telegramVerificationRequests',0)+1
                            await r.continue_(); return
                if u.hostname=='boards.greenhouse.io' and u.path=='/embed/prenuvo/jobs/4742463005' and sending['requests']==0:
                    sending['requests']+=1
                    report['submissionRequest']={'host':u.hostname,'path':u.path}
                    await r.continue_(); return
            if req.method not in ('GET','HEAD','OPTIONS'):
                blocked.append({'host':u.hostname,'path':u.path,'method':req.method,'contentType':req.headers.get('content-type','')})
                await r.abort('blockedbyclient'); return
            await r.continue_()
        await context.route('**/*',route)
        async def response_seen(response):
            u=urlsplit(response.url)
            if u.hostname=='grnhse-prod-jben-us-east-1.s3.amazonaws.com' and response.request.method=='POST':
                report.setdefault('uploadResponses',[]).append({'status':response.status})
            if u.hostname=='boards.greenhouse.io' and u.path=='/embed/prenuvo/jobs/4742463005' and response.request.method=='POST':
                report['submissionResponseStatus']=response.status
                try: body=await response.text()
                except Exception: body=''
                (BASE/'submission-response.json').write_text(json.dumps({'sessionId':session['id'],'status':response.status,'body':body}))
                try:
                    if response.status==428 and json.loads(body).get('code')=='captcha-failed': sending['verificationPending']=True
                except Exception: pass
        context.on('response',response_seen)
        page=context.pages[0] if context.pages else await context.new_page()
        def console_seen(message):
            if message.text in ('browserbase-solving-started','browserbase-solving-finished','browserbase-solving-errored'):
                report.setdefault('captchaEvents',[]).append({'event':message.text,'elapsedSeconds':round(time.monotonic()-started)})
                (BASE/'captcha-events.json').write_text(json.dumps(report['captchaEvents']))
        page.on('console',console_seen)
        await page.goto('https://browser-use-trial.invalid/',wait_until='domcontentloaded')
        await page.frame_locator('iframe').locator('form').wait_for()
        frame=page.frames[1]
        await frame.locator('button[type=submit]').click()
        await frame.evaluate('document.forms[0].submit();document.forms[0].requestSubmit()')
        assert await frame.evaluate('window.__fillOnlyBlocked')==3
        await frame.evaluate("fetch('/submit',{method:'POST',body:'synthetic guard probe'}).catch(()=>{})")
        assert any(x['path']=='/submit' for x in blocked)
        report['guardSelfTest']=True; blocked.clear()
        if mode=='synthetic':
            await page.reload(wait_until='domcontentloaded')
            (BASE/'synthetic-resume.txt').write_text('Fictional Test Candidate resume for controlled QA only.')
            facts={'Name':'Test Candidate','Email':'synthetic@example.test','Phone country':'India (+91)','Phone number':'9876543210','Location':'Hyderabad, Telangana, India','Work authorized?':'Yes'}
        else:
            baseline=json.loads(Path('.local-data/prenuvo-fill-existing.json').read_text())
            row=next(r for r in baseline if r['id']=='0c9caffb-b905-4971-a40f-7bc7f01c36b1')
            assert row['packet']==row['approved_packet']
            packet=row['packet']; facts=[]
            for f in packet['fields']:
                a=packet['answers'].get(f['id'])
                if f['id']=='frame1:country' or f['kind'] in ('resume','cover_letter') or not a: continue
                facts.append({'question':f['label'],'answer':a})
            facts.append({'note':'The phone country code is +91. Choose the matching dialing-code option. The old country answer incorrectly contained the full telephone number; do not repeat that mapping. Leave optional demographics blank.'})
            await page.goto(row['target_url'],wait_until='domcontentloaded',timeout=60000)
            await page.wait_for_timeout(3000)
        browser=Browser(cdp_url=session['connectUrl'],keep_alive=True,cross_origin_iframes=True,enable_default_extensions=False,allowed_domains=['browser-use-trial.invalid'] if mode=='synthetic' else ['app.careerpuck.com','job-boards.greenhouse.io','boards.greenhouse.io'])
        tools=Tools(exclude_actions=['navigate','go_back','switch','search','evaluate','write_file','replace_file','read_file','save_as_pdf','upload_file','close'])
        @tools.action('Upload the approved resume to a file input. Supply its exact DOM id seen in the page. Only the approved resume bytes are available.')
        async def upload_approved_resume(input_id: str) -> ActionResult:
            filename='synthetic-resume.txt' if mode=='synthetic' else 'resume.pdf'
            path=BASE/filename
            if not path.exists(): return ActionResult(error='Approved resume unavailable')
            for p in context.pages:
                for f in p.frames:
                    inputs=f.locator('input[type=file]')
                    for i in range(await inputs.count()):
                        control=inputs.nth(i)
                        if await control.get_attribute('id')==input_id:
                            upload_window['until']=time.monotonic()+20
                            await control.set_input_files({'name':filename,'mimeType':'text/plain' if mode=='synthetic' else 'application/pdf','buffer':path.read_bytes()})
                            return ActionResult(extracted_content='Approved bytes attached. Verify the employer attachment acknowledgement; selecting a file alone does not prove upload succeeded.')
            return ActionResult(error='No file input with that exact id. Inspect the form again.')
        model=ChatOpenAI(model=os.environ['BROWSER_USE_MODEL'],base_url=os.environ['OPENAI_BASE_URL'],api_key=os.environ['OPENAI_API_KEY'],max_retries=0,timeout=90,frequency_penalty=None,temperature=None,reasoning_effort=None)
        task='Fill the application already open, including its embedded frame, using only these approved facts: '+json.dumps(facts)+'. Attach the approved resume with upload_approved_resume. Independently inspect the resulting fields; search text in a dropdown is NOT a committed selection. Never click Submit, Send application, Complete application, or press Enter to submit. Stop before submitting. Do not navigate away. For controls below the viewport, prefer find_elements and the element indices instead of repeatedly scrolling the outer page. If scrolling is necessary, target the embedded frame index. If required data is missing or blocked, report it; do not invent facts or claim success.'
        agent=Agent(task=task,llm=model,browser=browser,tools=tools,use_vision=True,directly_open_url=False,max_actions_per_step=3,max_failures=3,use_judge=False,calculate_cost=False,enable_planning=False,step_timeout=150,llm_timeout=90,file_system_path=str(BASE/(mode+'-agent')))
        async def step(a):
            if (BASE/'stop').exists():
                report['stoppedByOperator'] = True
                a.stop()
            (BASE/(mode+'-progress.json')).write_text(json.dumps({'steps':len(a.history.history),'elapsedSeconds':round(time.monotonic()-started),'blockedWritePaths':blocked}))
            checkpoint=[]
            for f in page.frames:
                try:
                    checkpoint.append({'url':f.url,'text':(await f.locator('body').inner_text())[-18000:]})
                except Exception: pass
            (BASE/(mode+'-checkpoint.json')).write_text(json.dumps(checkpoint))
        try:
            if os.environ.get('USE_DETERMINISTIC_RECOVERY')=='true':
                report['deterministicRecoveryUsed']=True
                if not any(urlsplit(f.url).hostname=='job-boards.greenhouse.io' for f in page.frames):
                    await page.get_by_role('button',name=re.compile('^Apply',re.I)).first.click(timeout=15000)
                await page.frame_locator('iframe[src*="greenhouse.io"]').locator('#first_name').wait_for(timeout=30000)
                target=next(f for f in page.frames if urlsplit(f.url).hostname=='job-boards.greenhouse.io')
                for field in packet['fields']:
                    key=field['id']; control_id=key.split(':')[-1]; answer=packet['answers'].get(key)
                    if field['kind'] in ('resume','cover_letter') or not answer: continue
                    control=target.locator('[id="'+control_id+'"]')
                    if field['kind']=='combobox':
                        value='India' if control_id=='country' else str(answer)
                        await control.click(timeout=15000)
                        await control.fill(value)
                        if control_id=='country': pattern=re.compile(r'^India(?:\s|$)',re.I)
                        elif control_id=='candidate-location': pattern=re.compile(r'^Hyderabad, Telangana, India$',re.I)
                        else: pattern=re.compile('^'+re.escape(value)+'$',re.I)
                        option=target.get_by_role('option',name=pattern)
                        await option.wait_for(state='visible',timeout=20000)
                        if await option.count()!=1: raise RuntimeError('Ambiguous approved dropdown option')
                        await option.click(timeout=15000)
                    else: await control.fill(str(answer),timeout=15000)
                    (BASE/(mode+'-progress.json')).write_text(json.dumps({'deterministicRecovery':True,'lastFieldId':control_id,'elapsedSeconds':round(time.monotonic()-started)}))
                upload_window['until']=time.monotonic()+20
                await target.locator('#resume').set_input_files({'name':'resume.pdf','mimeType':'application/pdf','buffer':(BASE/'resume.pdf').read_bytes()})
                await target.get_by_text('resume.pdf',exact=True).wait_for(state='visible',timeout=30000)
                for _ in range(30):
                    if any(200<=x['status']<300 for x in report.get('uploadResponses',[])): break
                    await asyncio.sleep(1)
                if not any(200<=x['status']<300 for x in report.get('uploadResponses',[])): raise RuntimeError('Resume upload response not confirmed')
                if packet['answers'].get('frame1:cover_letter'):
                    await target.get_by_role('button',name='Enter manually',exact=True).last.click()
                    await target.locator('#cover_letter_text').fill(packet['answers']['frame1:cover_letter'])
                for contact_id in ('first_name','last_name','email'):
                    await target.locator('#'+contact_id).fill(packet['answers']['frame1:'+contact_id])
                history=agent.history
            else:
                history=await asyncio.wait_for(agent.run(max_steps=25,on_step_end=step),timeout=530)
            report.update(agentDone=history.is_done(),agentClaimsSuccess=history.is_successful(),steps=len(history.history),agentResult=history.final_result())
            if mode=='prenuvo-submit':
                # Only an operator-reviewed command enables the irreversible phase.
                # Default execution stays fill-only, including after agent 'done'.
                (BASE/'awaiting-review.json').write_text(json.dumps({'sessionId':session['id'],'state':'filled-awaiting-independent-review'}))
                while time.monotonic()-started<800:
                    command_path=BASE/'operator-command.json'
                    if not command_path.exists():
                        await asyncio.sleep(1); continue
                    command=json.loads(command_path.read_text());command_path.unlink()
                    if command.get('sessionId')!=session['id']: raise RuntimeError('Command session mismatch')
                    if command['operation']=='repair':
                        agent.add_new_task(command['instruction']+' Do not submit. Use only the original approved facts.')
                        history=await asyncio.wait_for(agent.run(max_steps=agent.state.n_steps+10,on_step_end=step),timeout=180)
                        (BASE/'awaiting-review.json').write_text(json.dumps({'sessionId':session['id'],'state':'repair-complete-awaiting-review'}))
                    elif command['operation']=='submit':
                        intent=json.loads((BASE/'send-intent.json').read_text())
                        if intent.get('sessionId')!=session['id'] or intent.get('status')!='submitting': raise RuntimeError('Durable send intent unavailable')
                        sending['enabled']=True; report['sendIntentPersisted']=True
                        candidates=[]
                        for p in context.pages:
                            for f in p.frames:
                                if urlsplit(f.url).hostname not in ('app.careerpuck.com','job-boards.greenhouse.io'): continue
                                button=f.get_by_role('button',name='Submit application',exact=True)
                                if await button.count()==1 and await button.is_visible(): candidates.append((f,button))
                        if len(candidates)!=1: raise RuntimeError('Expected exactly one visible application Submit button')
                        f,button=candidates[0]
                        await f.evaluate('window.__submissionEnabled=true')
                        report['submitClicked']=True
                        await button.click(timeout=15000)
                        (BASE/'submission-started.json').write_text(json.dumps({'sessionId':session['id'],'clicked':True}))
                        # Receipt/CAPTCHA inspection stays in this same browser; no resend.
                        until=min(started+845,time.monotonic()+600)
                        while time.monotonic()<until:
                            observations=[]
                            for p in context.pages:
                                for f in p.frames:
                                    try: observations.append({'url':f.url,'text':(await f.locator('body').inner_text())[-22000:]})
                                    except Exception: pass
                            (BASE/'submission-observations.json').write_text(json.dumps(observations))
                            await page.screenshot(path=str(BASE/'submission-live.png'),full_page=True)
                            if (BASE/'receipt-confirmed.json').exists() and json.loads((BASE/'receipt-confirmed.json').read_text()).get('sessionId')==session['id']: break
                            await asyncio.sleep(3)
                        break
                    elif command['operation']=='stop': break
                    else: raise RuntimeError('Unknown operator operation')

        except Exception as e:
            report['errorType']=type(e).__name__
            import traceback
            report['errorLocations']=[{'file':Path(x.filename).name,'line':x.lineno,'function':x.name} for x in traceback.extract_tb(e.__traceback__)[-3:]]
        finally:
            evidence=[]
            for p in context.pages:
                for f in p.frames:
                    try:
                        fields=await f.evaluate('''() => [...document.querySelectorAll('input,select,textarea')].map(e=>({id:e.id,name:e.name,type:e.type,role:e.getAttribute('role'),required:e.required,invalid:e.getAttribute('aria-invalid'),value:e.type==='file'?[...e.files].map(f=>({name:f.name,size:f.size})):e.value,selected:(()=>{let n=e.parentElement;for(let i=0;n&&i<5;i++,n=n.parentElement){if(n.tagName==='FORM'||n.querySelectorAll('input:not([type=hidden]),textarea,select').length!==1)break;let v=[...n.querySelectorAll('[class*="__single-value"],[class$="-singleValue"]')].map(x=>x.textContent);if(v.length)return v}return []})(),valid:e.checkValidity()}))''')
                        evidence.append({'url':f.url,'fields':fields,'text':(await f.locator('body').inner_text())[-18000:],'blockedSubmitEvents':await f.evaluate('window.__fillOnlyBlocked || 0')})
                    except Exception: pass
            report.update(evidence=evidence,blockedWrites=blocked,allowedResumeUploads=uploads,elapsedSeconds=round(time.monotonic()-started))
            if mode=='synthetic':
                f=next(x for x in evidence if urlsplit(x['url']).path=='/form'); values={x['name']:x['value'] for x in f['fields']}
                expected={'name':'Test Candidate','email':'synthetic@example.test','country':'IN','phone':'9876543210','city':'Hyderabad, Telangana, India','authorized':'Yes'}
                report['oracle']={k:values.get(k)==v for k,v in expected.items()};report['oracle']['resume']=bool(values.get('resume'));report['oraclePassed']=all(report['oracle'].values()) and not blocked
            await page.screenshot(path=str(BASE/(mode+'.png')),full_page=True)
            (BASE/(mode+'-report.json')).write_text(json.dumps(report,indent=2))
            await browser.stop()
            await remote.close()
    print(json.dumps({k:v for k,v in report.items() if k not in ('evidence','agentResult')}))

if __name__=='__main__':
    os.umask(0o077)
    asyncio.run(main(sys.argv[1] if len(sys.argv)>1 else 'synthetic'))
