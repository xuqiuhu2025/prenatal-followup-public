'use strict';
// Local, isolated service: the actual rehearsal handler, deterministic voice, no database or patient calls.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const C=require('../server/calling'),speech=require('../server/speech'),A=require('../server/followup-agent');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const out=process.env.CONNECTION_SHOTS||'.backups/20261111-connection',requests=[],errors=[],failures=[];
let synthesis=0,voiceGate=null,voiceFails=false,browser;
const originals={speak:speech.speak,recognize:speech.recognize,available:A.available};
speech.speak=async()=>{synthesis++;if(voiceFails)throw Error('test voice outage');if(voiceGate)await voiceGate.promise;return 'dGVzdA==';};
speech.recognize=async()=> '我是本人';A.available=()=>true;
const webapp=path.resolve(__dirname,'../webapp'),shared=new Set(['patient-validation.js','prenatal-data.js','customer-validation.js']);
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/cs-admin'&&req.method==='POST'){
  let body='';for await(const chunk of req)body+=chunk;const e=JSON.parse(body);requests.push(e);let r;
  if(e.action==='login')r={ok:true,token:'connection-qa',user:{id:'connection-qa',role:'admin',display_name:'虚拟测试医护'}};
  else if(e.token!=='connection-qa')r={ok:false,unauthorized:true};
  else if(e.action==='logout')r={ok:true};
  else if(e.action.startsWith('calling_'))r=await C.main({...e,recordedBy:'connection-browser-qa'});
  else throw Error('This isolated fixture allows no clinical API writes');
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(r));return;
 }
 const name=url.pathname.slice(1),file=shared.has(name.slice(3))&&name.startsWith('js/')?path.resolve(__dirname,'../server',name.slice(3)):path.resolve(webapp,name||'admin.html');
 if(!file.startsWith(webapp+path.sep)&&!shared.has(path.basename(file))){res.writeHead(403);res.end();return;}
 const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream')+'; charset=utf-8'});res.end(data);
 }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:e.message}));}
});
const count=action=>requests.filter(r=>r.action===action).length;
const last=action=>requests.filter(r=>r.action===action).at(-1);
async function waitUntil(check){for(let n=0;n<200;n++){if(check())return;await delay(25);}throw Error('Fixture condition timed out');}
async function open(p){await p.locator('#openRehearsal').click();}
async function started(p){await p.locator('#rehearsalConversation').waitFor({state:'visible'});await p.waitForFunction(()=>!document.querySelector('#sendRehearsal').disabled);}
async function close(p){const ended=p.waitForRequest(r=>r.url().endsWith('/cs-admin')&&r.postDataJSON().action==='calling_end');await p.locator('#closeRehearsal').click();await ended;await p.locator('#rehearsalDialog').waitFor({state:'hidden'});await delay(50);}
async function onceTimeout(p,action){await p.evaluate(action=>{const original=HospitalAdmin.call;let used=false;HospitalAdmin.call=function(a,d,o){if(a===action&&!used){used=true;return original(a,d,{...o,timeoutMs:150});}return original(a,d,o);};},action);}

(async()=>{
 await fs.mkdir(out,{recursive:true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'});
 const context=await browser.newContext({viewport:{width:1360,height:950}}),p=await context.newPage();p.setDefaultTimeout(12000);
 p.on('pageerror',e=>errors.push(e.message));p.on('requestfailed',r=>failures.push({path:new URL(r.url()).pathname,error:r.failure()?.errorText}));
 await p.addInitScript(()=>{window.played=[];window.Audio=class{constructor(){played.push(this);}async play(){}pause(){this.paused=true;}removeAttribute(){}load(){}};});
 await p.goto(base+'/admin.html#calling');await p.locator('#usernameInput').fill('qa');await p.locator('#pwdInput').fill('local-fixture');await p.locator('#btnLogin').click();await p.locator('#robotStatus').getByText('可试玩',{exact:true}).waitFor();
 await open(p);await p.locator('#startRehearsal').click();await started(p);assert.match(last('calling_start').requestId,/^[a-f0-9-]{36}$/);await close(p);

 // The server accepted the request, but its response was lost or truncated.
 for(const fault of ['lost','partial']){
  let attempts=0;const payloads=[],before=synthesis;
  await p.route('**/cs-admin',async route=>{const e=route.request().postDataJSON();if(e.action!=='calling_start')return route.continue();payloads.push(e);attempts++;if(attempts===1){const r=await route.fetch();assert.equal((await r.json()).ok,true);return fault==='lost'?route.abort('connectionreset'):route.fulfill({status:200,contentType:'application/json',body:'{"ok":'});}return route.continue();});
  await open(p);await p.locator('#startRehearsal').click();await started(p);assert.equal(attempts,2);assert.deepEqual(payloads[1],payloads[0]);assert.equal(synthesis-before,1);assert.equal(await p.locator('#rehearsalHistory .assistant').count(),1);await close(p);await p.unroute('**/cs-admin');
 }

 // A first timeout can happen while TTS is still running; a retry must join it.
 for(const action of ['calling_start','calling_turn']){
  await open(p);if(action==='calling_turn'){await p.locator('#startRehearsal').click();await started(p);}
  const before=count(action),voiceBefore=synthesis;voiceGate=deferred();await onceTimeout(p,action);
  if(action==='calling_start')await p.locator('#startRehearsal').click();else{await p.locator('#rehearsalAnswer').fill('我是本人');await p.locator('#sendRehearsal').click();}
  await waitUntil(()=>count(action)===before+2);assert.equal(synthesis-voiceBefore,1,'pending work is shared');voiceGate.resolve();voiceGate=null;
  if(action==='calling_start')await started(p);else{await p.waitForFunction(()=>document.querySelectorAll('#rehearsalHistory .respondent').length===1);assert.equal(await p.locator('#rehearsalAnswer').inputValue(),'');}
  const seen=requests.filter(r=>r.action===action).slice(-2);assert.deepEqual(seen[0],seen[1]);await close(p);
 }

 // After two failures, retain the same payload for explicit retry.
 let attempts=0;const payloads=[],voiceBefore=synthesis;
 await p.route('**/cs-admin',async route=>{const e=route.request().postDataJSON();if(e.action!=='calling_start')return route.continue();payloads.push(e);attempts++;if(attempts<=2){await route.fetch();return route.abort('connectionreset');}return route.continue();});
 await open(p);await p.locator('#startRehearsal').click();await p.locator('#rehearsalError').getByText(/暂时无法连接随访服务/).waitFor();assert.equal(attempts,2);assert.equal(await p.locator('[name=rehearsalStage]').isDisabled(),true);assert.match(await p.locator('#startRehearsal').innerText(),/重试/);assert.doesNotMatch(await p.locator('#rehearsalDialog').innerText(),/Failed to fetch/);
 await p.screenshot({path:out+'/edge-retry-start.png'});await p.locator('#startRehearsal').click();await started(p);assert.equal(attempts,3);assert.deepEqual(payloads[0],payloads[2]);assert.equal(synthesis-voiceBefore,1);await close(p);await p.unroute('**/cs-admin');

 // Explicit cancel prevents the scheduled retry and releases the uncertain session.
 let cancelledId,cancelAttempts=0;
 await p.route('**/cs-admin',async route=>{const e=route.request().postDataJSON();if(e.action!=='calling_start')return route.continue();cancelAttempts++;cancelledId=e.requestId;await route.fetch();return route.abort('connectionreset');});
 await open(p);await p.locator('#startRehearsal').click();await p.locator('#rehearsalConnecting').getByText(/自动重试/).waitFor();const endCount=count('calling_end');await p.locator('#cancelRehearsalStart').click();await waitUntil(()=>count('calling_end')>endCount);await delay(1100);assert.equal(cancelAttempts,1);assert.equal(await p.locator('[name=rehearsalStage]').isDisabled(),false);assert.equal((await C.main({action:'calling_start',recordedBy:'connection-browser-qa',requestId:cancelledId,stage:'notification',engine:'ai'})).ok,false);await p.unroute('**/cs-admin');await p.locator('#startRehearsal').click();await started(p);assert.notEqual(last('calling_start').requestId,cancelledId);await close(p);

 // Closing while the opening response is pending never plays late audio.
 await open(p);voiceGate=deferred();const starts=count('calling_start'),audioBefore=await p.evaluate(()=>played.length);await p.locator('#startRehearsal').click();await waitUntil(()=>count('calling_start')>starts);await close(p);voiceGate.resolve();voiceGate=null;await delay(1100);assert.equal(count('calling_start'),starts+1);assert.equal(await p.evaluate(()=>played.length),audioBefore);assert.equal(await p.locator('#rehearsalHistory .rehearsal-message').count(),0);

 await open(p);await context.setOffline(true);await p.locator('#startRehearsal').click();await p.locator('#rehearsalError').getByText(/网络已断开/).waitFor();await context.setOffline(false);await p.locator('#startRehearsal').click();await started(p);await close(p);
 voiceFails=true;await open(p);await p.locator('#startRehearsal').click();await started(p);await p.locator('#rehearsalError').getByText(/语音暂不可用/).waitFor();assert.equal(await p.locator('#sendRehearsal').isDisabled(),false);voiceFails=false;await p.locator('#rehearsalAnswer').fill('我是本人');await p.locator('#sendRehearsal').click();await p.waitForFunction(()=>document.querySelectorAll('#rehearsalHistory .respondent').length===1);await close(p);

 // Common API normalization does not automatically repeat clinical writes.
 let clinicalAttempts=0;await p.route('**/cs-admin',async route=>{if(route.request().postDataJSON().action!=='patient_save')return route.continue();clinicalAttempts++;return route.fulfill({status:503,body:'test'});});
 assert.match(await p.evaluate(async()=>{try{await HospitalAdmin.call('patient_save',{});}catch(e){return e.message;}}),/503/);assert.equal(clinicalAttempts,1);await p.unroute('**/cs-admin');
 await open(p);await p.locator('#startRehearsal').click();await started(p);await p.setViewportSize({width:320,height:900});assert.ok(await p.evaluate(()=>{const d=document.querySelector('#rehearsalDialog');return d.scrollWidth<=d.clientWidth&&d.getBoundingClientRect().right<=innerWidth;}));await p.screenshot({path:out+'/edge-recovered-mobile.png'});await close(p);
 assert.deepEqual(errors,[]);console.log('PASS '+await browser.version()+': Edge startup, lost/truncated response recovery, pending start/turn timeouts, manual retry, cancellation/late response, offline recovery, text fallback, no repeated clinical writes, mobile layout. Injected network failures: '+failures.length);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{voiceGate?.resolve();await browser?.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));Object.assign(speech,{speak:originals.speak,recognize:originals.recognize});A.available=originals.available;});
