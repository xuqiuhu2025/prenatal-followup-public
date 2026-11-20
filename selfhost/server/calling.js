'use strict';
const crypto=require('crypto'),D=require('./followup-dialogue'),A=require('./followup-agent'),speech=require('./speech');
const profiles=require('./speech-profiles'),previews=new Map();
const sessions=new Map(),cancelledStarts=new Map(),TTL=30*60*1000;
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const startKey=(actor,requestId)=>actor+':'+requestId;
function sweep(){const now=Date.now();for(const [id,s]of sessions)if(now-s.updated>TTL&&!s.busy)sessions.delete(id);for(const [key,time]of cancelledStarts)if(now-time>TTL)cancelledStarts.delete(key);}
function cancelStart(actor,requestId){if(!requestId)return;cancelledStarts.set(startKey(actor,requestId),Date.now());if(cancelledStarts.size>1000)cancelledStarts.delete(cancelledStarts.keys().next().value);}
setInterval(sweep,60000).unref();
function owner(e){sweep();const s=sessions.get(e.id);if(!s||s.actor!==String(e.recordedBy))throw Error('演练已过期或不可访问，请重新开始');return s;}
async function output(s,reply,transcript=''){
 let audio=null,audioError='';try{audio=await speech.speak(reply,undefined,s.voice);}catch{audioError='语音暂不可用，可阅读文字并继续回答。';}
 return {ok:true,id:s.id,revision:s.revision,mode:'rehearsal',dialogueMode:s.kind,voice:s.voice,...(s.kind==='ai'?A:D).snapshot(s.dialogue),reply,transcript,audio,audioMime:'audio/mpeg',audioError};
}
async function main(e){try{
 if(!e.recordedBy)throw Error('请先登录');
 if(e.action==='calling_status')return {ok:true,manualDial:true,rehearsal:true,aiConfigured:A.available(),modes:['ai','scripted'],voiceSettings:profiles.catalog(),...require('./telephony').status()};
 if(e.action==='calling_voice_preview'){
  const voice=profiles.resolve(e.voice),key=voice.id+'|'+voice.speed;
  // At most nine fixed samples. Never accept patient text or cache a conversation.
  if(!previews.has(key)){
   const pending=Promise.resolve().then(()=>speech.speak(profiles.SAMPLE_TEXT,undefined,voice)).then(audio=>({ok:true,text:profiles.SAMPLE_TEXT,audio,audioMime:'audio/mpeg',voice}));
   previews.set(key,pending);pending.catch(()=>{if(previews.get(key)===pending)previews.delete(key);});
  }
  return await previews.get(key);
 }
 if(e.action==='calling_dial'||e.action.startsWith('calling_phone_'))return await require('./telephony').main(e);
 if(e.action==='calling_start'){
  sweep();const actor=String(e.recordedBy);if(e.requestId&&!uuid(e.requestId))throw Error('请求标识无效');
  if(e.requestId&&cancelledStarts.has(startKey(actor,e.requestId)))throw Error('本次试玩已取消，请重新开始');
  const kind=e.engine||'scripted';if(!['ai','scripted'].includes(kind))throw Error('请选择智能对话或标准问卷');if(kind==='ai'&&!A.available())throw Error('语言模型尚未配置，可先选择标准问卷');
  const voice=profiles.resolve(e.voice);
  const startHash=hash({kind,stage:e.stage,count:Number(e.count||1),voice}),existing=e.requestId&&[...sessions.values()].find(s=>s.actor===actor&&s.startRequest===e.requestId);
  if(existing){if(existing.startHash!==startHash)throw Error('同一次启动的设置已改变，请重新开始');existing.updated=Date.now();return existing.last?.response||await existing.opening;}
  if([...sessions.values()].filter(s=>s.actor===actor).length>=3)throw Error('最多同时保留3个演练，请先结束其他演练');if(sessions.size>=200)throw Error('演练繁忙，请稍后再试');
  const dialogue=(kind==='ai'?A:D).create(e.stage,Number(e.count||1)),id=crypto.randomUUID(),s={id,actor,kind,voice,dialogue,revision:0,updated:Date.now(),busy:true,last:null,startRequest:e.requestId,startHash};sessions.set(id,s);
  s.opening=(async()=>{try{const r=await output(s,kind==='ai'?A.INTRO:D.intro);if(!sessions.has(id))throw Error('试玩已结束');return r;}finally{s.busy=false;}})();return await s.opening;
 }
 if(e.action==='calling_end'){
  if(!e.id&&uuid(e.requestId)){const actor=String(e.recordedBy);cancelStart(actor,e.requestId);const s=[...sessions.values()].find(s=>s.actor===actor&&s.startRequest===e.requestId);if(s)sessions.delete(s.id);return {ok:true};}
  const s=owner(e);cancelStart(s.actor,s.startRequest);sessions.delete(s.id);return {ok:true};
 }
 if(e.action==='calling_turn'){
  const s=owner(e);if(!uuid(e.requestId))throw Error('请求标识无效');
  if((typeof e.answer==='string'&&e.answer.trim())&&e.audio)throw Error('请选择文字或语音中的一种回答');
  if(!e.audio&&(typeof e.answer!=='string'||!e.answer.trim()||e.answer.length>1000))throw Error('请提供1–1000字回答');
  if(e.audio&&(typeof e.audio!=='string'||e.audio.length>4*1024*1024))throw Error('录音超过大小限制');
  const digest=hash({answer:e.answer||'',audio:e.audio||'',revision:e.revision});
  if(s.last?.id===e.requestId){if(s.last.hash!==digest)throw Error('重复请求内容已改变');return s.last.response;}
  if(s.pending?.id===e.requestId){if(s.pending.hash!==digest)throw Error('重复请求内容已改变');return await s.pending.promise;}
  if(s.busy)throw Error('上一段回答正在处理中，请稍后再试');if(e.revision!==s.revision)throw Error('演练进度已变化，请重新开始');
  s.busy=true;s.updated=Date.now();const pending={id:e.requestId,hash:digest,promise:null};s.pending=pending;pending.promise=(async()=>{try{
   const transcript=e.audio?await speech.recognize(e.audio):e.answer.trim();if(!sessions.has(s.id))throw Error('演练已结束');
   const next=structuredClone(s.dialogue),result=await(s.kind==='ai'?A:D).advance(next,transcript);if(!sessions.has(s.id))throw Error('试玩已结束');s.dialogue=next;s.revision++;
   const response=await output(s,result.reply,transcript);if(!sessions.has(s.id))throw Error('试玩已结束');s.last={id:e.requestId,hash:digest,response};return response;
  }finally{s.busy=false;s.pending=null;s.updated=Date.now();}})();return await pending.promise;
 }
 return {ok:false,error:'未知电话操作'};
}catch(err){return {ok:false,error:err.message||'语音演练暂不可用'};}}
module.exports={main};
