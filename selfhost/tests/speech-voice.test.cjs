'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{PassThrough}=require('node:stream'),crypto=require('node:crypto');
const engine=require('../tts-proxy/tts-engine'),profiles=require('../server/speech-profiles');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('voice options reject arbitrary voices and markup; paragraph pauses preserve medical data and full text',()=>{
 assert.deepEqual(profiles.catalog().default,{id:'xiaoxiao',speed:'calm'});
 for(const choice of [{id:'__proto__'},{id:'https://elsewhere'},{speed:'fast'},'xiaoxiao'])assert.throws(()=>profiles.resolve(choice));
 const source='孕周37+2，体重2.75kg，A&B。\n下次核对 <break time="9s"/>\n'+ '后续内容'.repeat(160);
 const output=engine.normalize({text:source,voice:'zh-CN-XiaoyiNeural',rate:'-12%'});
 assert.equal(output.voice,'zh-CN-XiaoyiNeural');assert.equal(output.rate,'-12%');
 assert.ok(output.text.startsWith('孕周37+2，体重2.75kg，A&amp;B。下次核对 &lt;break time=&quot;9s&quot;/&gt;。'));
 assert.ok(output.text.endsWith('后续内容'.repeat(160)),'no silent 600-character truncation');
 assert.throws(()=>engine.normalize({text:'测试',rate:'-90%'}));
 assert.throws(()=>engine.normalize({text:'测试',voice:'other'}));
 assert.throws(()=>engine.normalize({text:'字'.repeat(1001)}));
 assert.throws(()=>engine.normalize({text:null}));
});

test('one cancelled preview does not cancel another voice or change its speed; truncated audio is rejected',async()=>{
 const instances=[],calls=[];
 class FakeTts {
  constructor(){instances.push(this);}
  async setMetadata(voice){this.voice=voice;}
  toStream(text,options){const audioStream=new PassThrough();calls.push({voice:this.voice,text,options,audioStream});return {audioStream};}
  close(){this.closed=true;}
 }
 const synth=engine.createSynthesizer({library:{MsEdgeTTS:FakeTts,OUTPUT_FORMAT:{AUDIO_24KHZ_48KBITRATE_MONO_MP3:'mp3'}},timeoutMs:1000});
 const controller=new AbortController();
 const first=synth.synthesize(engine.normalize({text:'第一条',rate:'-5%'}),controller.signal);
 const second=synth.synthesize(engine.normalize({text:'第二条',voice:'zh-CN-YunxiNeural',rate:'+0%'}));
 const cancelled=assert.rejects(first,/取消/);await tick();controller.abort();
 calls[1].audioStream.end(Buffer.alloc(180,2));assert.equal((await second).length,180);await cancelled;
 assert.equal(calls[0].voice,'zh-CN-XiaoxiaoNeural');assert.equal(calls[1].voice,'zh-CN-YunxiNeural');assert.equal(calls[1].options.rate,'+0%');
 const truncated=synth.synthesize(engine.normalize({text:'第三条'})),rejected=assert.rejects(truncated,/中断/);await tick();calls[2].audioStream.destroy();await rejected;
 const recovered=synth.synthesize(engine.normalize({text:'第四条'}));await tick();calls[3].audioStream.end(Buffer.alloc(200));assert.equal((await recovered).length,200);
 assert.equal(instances.length,2,'connections reused per voice');synth.close();assert.ok(instances.every(x=>x.closed));
});

test('authenticated preview and whole rehearsal use selected voice through HTTP, retries and text-only fallback',async()=>{
 const seen=[];let fail=false;
 const {server}=engine.createServer({env:{},synthesizer:{async synthesize(settings){seen.push(settings);if(fail)throw Error('private upstream error');return Buffer.alloc(180,4);}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const oldUrl=process.env.TTS_URL;process.env.TTS_URL='http://127.0.0.1:'+server.address().port;
 const speechFile=require.resolve('../server/speech'),callingFile=require.resolve('../server/calling');
 delete require.cache[speechFile];delete require.cache[callingFile];
 const speech=require(speechFile),C=require(callingFile),actor=crypto.randomUUID(),ids=[];
 const call=(action,data={})=>C.main({action,recordedBy:actor,...data});
 try{
  assert.equal((await C.main({action:'calling_voice_preview'})).ok,false);
  assert.equal(seen.length,0);
  const voice={id:'xiaoyi',speed:'slow'};
  const [a,b]=await Promise.all([call('calling_voice_preview',{voice,text:'PRIVATE PATIENT DATA'}),call('calling_voice_preview',{voice})]);
  assert.equal(a.ok,true);assert.deepEqual(a,b);assert.equal(seen.length,1);assert.equal(seen[0].text,profiles.SAMPLE_TEXT);
  assert.equal(seen[0].voice,'zh-CN-XiaoyiNeural');assert.equal(seen[0].rate,'-12%');
  const payload={stage:'postnatal',count:1,engine:'scripted',requestId:crypto.randomUUID(),voice};
  const started=await call('calling_start',payload);assert.equal(started.ok,true);ids.push(started.id);assert.equal(started.voice.speed,'slow');
  const before=seen.length;assert.deepEqual(await call('calling_start',payload),started);assert.equal(seen.length,before);
  assert.equal((await call('calling_start',{...payload,voice:{id:'yunxi',speed:'slow'}})).ok,false);
  const turn=await call('calling_turn',{id:started.id,requestId:crypto.randomUUID(),revision:0,answer:'我是本人',voice:{id:'yunxi',speed:'standard'}});
  assert.equal(turn.ok,true);assert.equal(seen.at(-1).voice,'zh-CN-XiaoyiNeural');assert.equal(seen.at(-1).rate,'-12%');
  fail=true;
  const failedPreview=await call('calling_voice_preview',{voice:{id:'yunxi',speed:'calm'}});assert.equal(failedPreview.ok,false);assert.doesNotMatch(failedPreview.error,/private/);
  const fallback=await call('calling_turn',{id:started.id,requestId:crypto.randomUUID(),revision:1,answer:'同意'});assert.equal(fallback.ok,true);assert.equal(fallback.audio,null);assert.ok(fallback.audioError);
  fail=false;assert.equal((await call('calling_voice_preview',{voice:{id:'yunxi',speed:'calm'}})).ok,true);
  const malformed=await fetch(process.env.TTS_URL+'/tts',{method:'POST',body:'{'});assert.equal(malformed.status,400);
  const rejected=await fetch(process.env.TTS_URL+'/tts',{method:'POST',body:JSON.stringify({text:'测试',rate:'-90%'})});assert.equal(rejected.status,400);
  const originalFetch=global.fetch;
  try{global.fetch=async()=>new Response(Buffer.alloc(180));await assert.rejects(speech.speak('旧代理'),/尚未更新/);}finally{global.fetch=originalFetch;}
 }finally{
  for(const id of ids)await call('calling_end',{id});
  if(oldUrl===undefined)delete process.env.TTS_URL;else process.env.TTS_URL=oldUrl;
  await new Promise(resolve=>server.close(resolve));
 }
});
