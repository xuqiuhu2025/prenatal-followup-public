'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {Vad}=require('../server/telephony-audio'),{PhoneSession}=require('../server/telephony-session');
const segments=require('../server/telephone-speech'),phrases=require('../server/telephone-phrases'),A=require('../server/followup-agent'),llm=require('../server/llm');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(fn){for(let n=0;n<200;n++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('condition timed out');}
const voice=Buffer.alloc(320);for(let i=0;i<160;i++)voice.writeInt16LE(6000,i*2);
const quiet=Buffer.alloc(320);
function feed(v,chunk,n){for(let i=0;i<n;i++)v.push(chunk);}
function fixture(t,speech){
  const inputs=[],drafts=[],writes=[],socket=new EventEmitter();Object.assign(socket,{destroyed:false,writableLength:0,write(data){writes.push(data);return true;},end(){this.destroyed=true;},destroy(){this.destroyed=true;}});
  const agent={create:()=>({stage:'postnatal',phase:'questions',history:[{role:'assistant',text:'开场'}],done:false,outcome:'in_progress'}),snapshot:s=>structuredClone(s),
    async advance(s,text){inputs.push(text);s.history.push({role:'user',text});return {reply:'已经收到您的描述，我们继续聊聊宝宝的情况。宝宝出生后吃得怎么样？',done:false};}};
  const store={async answered(){},async event(){},async suppress(){},async draft(id,d){drafts.push(d);}};
  const call=new PhoneSession({row:{id:crypto.randomUUID(),stage:'postnatal',fetus_count:1,phone:'6004'},socket,config:{silenceMs:600,vadThreshold:500,maxMs:10000},agent,speech,store,openingAudio:quiet,onClose:async()=>{}});
  t.after(()=>call.close('ended','cleanup'));return {call,inputs,drafts,writes};
}
test('speculative ASR is discarded if the caller resumes; no words are clipped at either pause',()=>{
  const v=new Vad({silenceMs:600,previewMs:260}),preview=[],resume=[],final=[];
  v.on('preview',(pcm,m)=>preview.push({pcm,m}));v.on('resume',id=>resume.push(id));v.on('utterance',(pcm,m)=>final.push({pcm,m}));
  feed(v,voice,10);feed(v,quiet,13);assert.equal(preview.length,1);assert.equal(final.length,0);
  feed(v,voice,10);assert.deepEqual(resume,[1]);feed(v,quiet,30);
  assert.equal(preview.length,2);assert.equal(final.length,1);assert.equal(final[0].m.silenceMs,600);
  assert.deepEqual(final[0].pcm,preview[1].pcm);assert.equal(final[0].pcm.length,(200+260+200+260)*16);
});
test('recognition starts during the endpoint wait, but interpretation waits for the final utterance',async t=>{
  const recognized=[];const f=fixture(t,{async recognizePcm(pcm,signal){recognized.push({pcm,signal});return recognized.length===1?'半句':'完整回答';},async speakPcm(){return quiet;}});
  feed(f.call.vad,voice,10);feed(f.call.vad,quiet,13);await tick();assert.equal(recognized.length,1);assert.equal(f.inputs.length,0);
  feed(f.call.vad,voice,10);assert.equal(recognized[0].signal.aborted,true);feed(f.call.vad,quiet,13);await tick();assert.equal(recognized.length,2);assert.equal(f.inputs.length,0);
  feed(f.call.vad,quiet,17);await until(()=>!f.call.busy&&f.inputs.length===1);assert.deepEqual(f.inputs,['完整回答']);assert.equal(recognized.length,2);
  assert.equal(f.call.metrics[0].earlyAsr,true);assert.equal(f.call.metrics[0].endpointMs,600);assert(f.call.metrics[0].fromSpeechEndMs>=600);
});
test('first sentence is audible while the next is still synthesizing, and barge-in cancels the rest',async t=>{
  const signals=[];let release;const pending=new Promise(r=>release=r);
  const f=fixture(t,{async recognizePcm(){return '测试回答';},async speakPcm(text,signal){signals.push(signal);if(signals.length===2)await pending;return Buffer.alloc(16000);}});
  feed(f.call.vad,voice,10);feed(f.call.vad,quiet,30);await until(()=>f.call.robotSpeaking);
  assert.equal(signals.length,2);assert(f.writes.length>0);assert.equal(f.call.transcript.at(-1).delivery,'playing');
  feed(f.call.vad,voice,6);assert(signals.every(s=>s.aborted));assert.equal(f.call.robotSpeaking,false);release();
  await until(()=>!f.call.busy);assert.equal(f.call.transcript.at(-1).delivery,'interrupted');assert.equal(f.call.transcript.at(-1).spokenParts.length,0);
});
test('sentence batching preserves decimals and only fixed strings can enter the shared cache',()=>{
  const text='出生体重是3.25千克，我先保留您的描述。宝宝最近吃奶怎么样？';
  const parts=segments.split(text);assert.equal(parts.join(''),text);assert.equal(parts.length,2);assert(parts[0].includes('3.25'));
  for(const phrase of phrases.warm)assert(phrases.cacheable(phrase));
  assert(!phrases.cacheable('您好，我是李女士，宝宝3.25千克。'));
  assert(!phrases.cacheable('好，谢谢您。李女士今天出血了。'));
});
test('telephone audio trims trailing padding but preserves quiet speech, internal pauses, and a natural tail',()=>{
  const faint=Buffer.alloc(320);for(let i=0;i<160;i++)faint.writeInt16LE(32,i*2);
  const prefix=Buffer.concat([Buffer.alloc(640),voice,Buffer.alloc(9600),faint]);
  const audio=Buffer.concat([prefix,Buffer.alloc(16000)]);
  const trimmed=segments.trimTail(audio);
  assert.equal(trimmed.length,prefix.length+2560);
  assert.deepEqual(trimmed.subarray(0,prefix.length),prefix);
  const short=Buffer.concat([voice,Buffer.alloc(3200)]);assert.equal(segments.trimTail(short),short);
  const silent=Buffer.alloc(16000);assert.equal(segments.trimTail(silent),silent);
});

test('compact telephone prompt keeps corrections, every field, and strict verbatim evidence validation',async t=>{
  const old=llm.chat,oldModel=process.env.LLM_MODEL_TELEPHONE;t.after(()=>{llm.chat=old;if(oldModel===undefined)delete process.env.LLM_MODEL_TELEPHONE;else process.env.LLM_MODEL_TELEPHONE=oldModel;});let request,options;
  process.env.LLM_MODEL_TELEPHONE='deepseek-v4.1-flash';
  const s=A.create('postnatal',2,{mode:'telephone'});await A.advance(s,'我是本人');await A.advance(s,'现在方便');
  s.facts.f2_perinatal={quotes:['小宝出生体重3.25千克'],complete:false,uncertain:false,corrected:false};
  const text='更正，小宝出生体重是2.75千克。';
  llm.chat=async(messages,opts)=>{request=JSON.parse(messages[1].content);options=opts;assert(messages[0].content.length<A.SYSTEM.length);return JSON.stringify({intent:'answer',updates:[{key:'f2_perinatal',evidence:'小宝出生体重是2.75千克',complete:false,uncertain:false,correction:true},{key:'maternal_recovery',evidence:'恢复正常',complete:true,uncertain:false}],nextKey:'maternal_recovery',reply:'您这阵子身体恢复得怎么样？'});};
  await A.advance(s,text);assert(request.questions.some(q=>q.key==='f2_perinatal'));assert(request.draft.some(d=>d.answer.includes('3.25千克')));
  assert.equal(request.userText,text);assert(!s.facts.maternal_recovery);assert(s.facts.f2_perinatal.quotes.includes('小宝出生体重是2.75千克'));assert.equal(s.changes.length,1);assert.equal(options.timeoutMs,6000);assert.equal(options.reasoningEffort,'none');assert.deepEqual(options.thinking,{type:'disabled'});assert.equal(options.model,'deepseek-v4.1-flash');
});
test('a medical question about the baby is a review request, not a reported illness',async t=>{
  const old=llm.chat;t.after(()=>llm.chat=old);
  const s=A.create('postnatal',1,{mode:'telephone'});await A.advance(s,'我是本人');await A.advance(s,'现在方便');
  llm.chat=async()=>JSON.stringify({intent:'medical_question',updates:[],nextKey:'maternal_recovery',reply:'请问医生'});
  const result=await A.advance(s,'这个检查结果是不是说明孩子有病，要吃什么药？');
  assert.equal(A.snapshot(s).answers.length,0);assert.equal(s.review.length,1);assert.match(result.reply,/医生/);
});
test('a slow model route is hedged once; first valid reply cancels the slow request',async()=>{
  const {understand}=require('../server/telephone-understanding'),signals=[];let timing;
  const result=await understand(async(messages,options)=>{signals.push(options.signal);if(signals.length===1)return new Promise(resolve=>options.signal.addEventListener('abort',()=>resolve(null),{once:true}));options.onTiming({model:'test',totalMs:1});return 'valid';},[],{onTiming:t=>timing=t},s=>s==='valid',{hedgeMs:15,totalMs:150});
  assert.equal(result,'valid');assert.equal(signals.length,2);assert(signals[0].aborted);assert.equal(timing.hedged,true);assert.equal(timing.attempts,2);
});
test('a fast valid model reply is never duplicated, and cancellation blocks a late result',async()=>{
  const {understand}=require('../server/telephone-understanding');let calls=0;
  assert.equal(await understand(async()=>{calls++;return 'valid';},[],{},s=>s==='valid',{hedgeMs:15,totalMs:100}),'valid');await new Promise(r=>setTimeout(r,25));assert.equal(calls,1);
  const controller=new AbortController();let finish,signal;
  const pending=understand(async(m,o)=>{signal=o.signal;return new Promise(r=>finish=r);},[],{signal:controller.signal},()=>true,{hedgeMs:50,totalMs:200});
  await tick();controller.abort();assert.equal(await pending,null);assert(signal.aborted);finish('late');
});
test('invalid model JSON never wins and a hung provider cannot exceed the call deadline',async()=>{
  const {understand}=require('../server/telephone-understanding');let calls=0;
  const result=await understand(async()=>++calls===1?'invalid':'valid',[],{},s=>s==='valid',{hedgeMs:80,totalMs:200});assert.equal(result,'valid');assert.equal(calls,2);
  const signals=[];const timed=await understand(async(m,o)=>{signals.push(o.signal);return new Promise(()=>{});},[],{},()=>false,{hedgeMs:15,totalMs:50});assert.equal(timed,null);assert.equal(signals.length,2);assert(signals.every(s=>s.aborted));
});
