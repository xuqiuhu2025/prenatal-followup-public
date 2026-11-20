'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'../server/node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {createFixture}=require('./voice-preview-fixture.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const out=process.env.VOICE_SHOTS||'.backups/voice-upgrade-20261113-191155/browser';
let browser;const f=createFixture();
(async()=>{
 await fs.mkdir(out,{recursive:true});await new Promise(resolve=>f.server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge'});
 const p=await browser.newPage({viewport:{width:1360,height:1000}}),errors=[];p.on('pageerror',e=>errors.push(e.message));p.setDefaultTimeout(10000);
 await p.addInitScript(()=>{window.played=[];window.Audio=class{constructor(){played.push(this);}async play(){}pause(){this.paused=true;}removeAttribute(){}load(){}};});
 await p.goto('http://127.0.0.1:'+f.server.address().port+'/admin.html#calling');
 await p.locator('#usernameInput').fill('qa');await p.locator('#pwdInput').fill('local');await p.locator('#btnLogin').click();
 await p.locator('#robotStatus').getByText('可试玩',{exact:true}).waitFor();await p.locator('#openRehearsal').click();
 const voice=p.locator('[name=rehearsalVoice]'),speed=p.locator('[name=rehearsalVoiceSpeed]'),preview=p.locator('#previewRehearsalVoice');
 assert.equal(await voice.inputValue(),'xiaoxiao');assert.equal(await speed.inputValue(),'calm');
 const started=f.requests.filter(x=>x.action==='calling_start').length;
 await preview.click();await p.locator('#rehearsalVoiceStatus').getByText(/正在试听/).waitFor();
 assert.equal(f.requests.filter(x=>x.action==='calling_start').length,started,'preview creates no session');
 assert.equal(await preview.innerText(),'停止试听');await preview.click();assert.equal(await p.evaluate(()=>played.at(-1).paused),true);
 await voice.selectOption('xiaoyi');await speed.selectOption('slow');
 await preview.click();await p.locator('#rehearsalVoiceStatus').getByText(/正在试听.*晓伊/).waitFor();
 assert.equal(f.utterances.at(-1).voice.rate,'-12%');await p.screenshot({path:path.join(out,'voice-desktop.png')});
 await p.locator('#startRehearsal').click();await p.locator('#rehearsalConversation').waitFor({state:'visible'});
 assert.deepEqual(f.requests.filter(x=>x.action==='calling_start').at(-1).voice,{id:'xiaoyi',speed:'slow'});
 assert.equal(await p.evaluate(()=>played.at(-2).paused),true,'starting cancels preview');
 await p.locator('#rehearsalAnswer').fill('我是本人');await p.locator('#sendRehearsal').click();await p.waitForFunction(()=>document.querySelectorAll('#rehearsalHistory .respondent').length===1);
 assert.equal(f.utterances.at(-1).voice.id,'xiaoyi');assert.equal(f.utterances.at(-1).voice.rate,'-12%');await p.locator('#closeRehearsal').click();
 // Late audio after close must never play.
 await p.locator('#openRehearsal').click();await voice.selectOption('yunxi');await speed.selectOption('calm');
 let release;f.settings.gate=new Promise(resolve=>release=resolve);const before=f.utterances.length,playedBefore=await p.evaluate(()=>played.length);
 await preview.click();for(let i=0;i<100&&f.utterances.length===before;i++)await delay(10);
 assert.equal(f.utterances.length,before+1);await p.locator('#closeRehearsal').click();release();f.settings.gate=null;await delay(200);
 assert.equal(await p.evaluate(()=>played.length),playedBefore);
 // Failed preview leaves setup usable and can be retried.
 await p.locator('#openRehearsal').click();await voice.selectOption('xiaoyi');await speed.selectOption('standard');f.settings.fail=true;
 await preview.click();await p.locator('#rehearsalVoiceStatus').getByText(/不可用/).waitFor();assert.equal(await preview.isDisabled(),false);f.settings.fail=false;
 await preview.click();await p.locator('#rehearsalVoiceStatus').getByText(/正在试听/).waitFor();
 await voice.selectOption('xiaoxiao');assert.equal(await p.evaluate(()=>played.at(-1).paused),true);
 await speed.focus();await p.keyboard.press('Tab');assert.equal(await preview.evaluate(el=>document.activeElement===el),true);assert.ok(await preview.evaluate(el=>getComputedStyle(el).outlineStyle!=='none'));
 for(const width of [320,390,768]){
  await p.setViewportSize({width,height:900});await p.locator('#rehearsalVoiceSettings').scrollIntoViewIfNeeded();
  assert.ok(await p.evaluate(()=>{const d=document.querySelector('#rehearsalDialog'),b=document.querySelector('.rehearsal-body');return d.scrollWidth<=d.clientWidth&&b.scrollWidth<=b.clientWidth&&d.getBoundingClientRect().right<=innerWidth;}),'no overflow at '+width);
  await p.screenshot({path:path.join(out,'voice-'+width+'.png')});
 }
 await p.locator('#closeRehearsal').click();assert.deepEqual(errors,[]);
 console.log('PASS voice preview: defaults, playback, selected voice across turns, stop/change/close, late response, failure retry, keyboard focus, 320/390/768/1360 layouts');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(resolve=>f.server.close(resolve));});
