'use strict';
const {execFile}=require('child_process'),fs=require('fs/promises'),path=require('path'),os=require('os');
const profiles=require('./speech-profiles');
const ASR_URL=(process.env.ASR_URL||'http://cs-asr:8000').replace(/\/+$/,'');
const TTS_URL=(process.env.TTS_URL||'http://host.docker.internal:28852').replace(/\/+$/,'');
async function recognize(base64){
 if(typeof base64!=='string'||!base64.length||base64.length>4*1024*1024||base64.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw Error('录音格式无效或超过3MB，请录制较短回答');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'followup-rehearsal-'));
 try{
  const input=path.join(dir,'input.bin'),output=path.join(dir,'audio.wav');await fs.writeFile(input,Buffer.from(base64,'base64'));
  await new Promise((resolve,reject)=>execFile('ffmpeg',['-v','error','-y','-i',input,'-t','30','-ar','16000','-ac','1','-f','wav',output],{timeout:15000,maxBuffer:128*1024},err=>err?reject(Error('无法解析录音，请重试')):resolve()));
  const form=new FormData();form.append('file',new Blob([await fs.readFile(output)],{type:'audio/wav'}),'audio.wav');
  const r=await fetch(ASR_URL+'/asr',{method:'POST',body:form,signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error('语音识别暂不可用，请重试或使用文字回答');
  const result=await r.json(),text=String(result.text||'').trim();if(!text)throw Error('没有听清，请重新录音或输入文字');if(text.length>1000)throw Error('回答过长，请缩短后重试');return text;
 }finally{await fs.rm(dir,{recursive:true,force:true});}
}
async function speak(text,signal,selection){
 const voice=profiles.resolve(selection);
 const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,20000);
 if(signal?.aborted){clearTimeout(timer);throw Error('语音播报已取消');}signal?.addEventListener('abort',cancel,{once:true});
 try{const r=await fetch(TTS_URL+'/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,voice:voice.voice,rate:voice.rate}),signal:controller.signal});
  if(!r.ok)throw Error('语音播报暂不可用');
  if(r.headers.get('X-TTS-Voice')!==voice.voice||r.headers.get('X-TTS-Rate')!==voice.rate)throw Error('语音服务尚未更新，暂时不能应用所选音色和语速');
  const data=Buffer.from(await r.arrayBuffer());if(data.length<100||data.length>5*1024*1024)throw Error('语音内容无效');return data.toString('base64');
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
// Telephone input is already PCM: wrap/resample in memory, avoiding a process per ASR turn.
async function recognizePcm(pcm,signal){
 if(!Buffer.isBuffer(pcm)||!pcm.length||pcm.length%2||pcm.length>320000)throw Error('电话语音长度无效');
 const converted=Buffer.alloc(pcm.length*2);for(let i=0;i<pcm.length;i+=2){const v=pcm.readInt16LE(i);converted.writeInt16LE(v,i*2);converted.writeInt16LE(v,i*2+2);}
 const form=new FormData();form.append('file',new Blob([require('./telephony-audio').wav(converted,16000)],{type:'audio/wav'}),'call.wav');
 const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,8000);
 if(signal?.aborted){clearTimeout(timer);throw Error('通话已取消');}signal?.addEventListener('abort',cancel,{once:true});
 try{const r=await fetch(ASR_URL+'/asr',{method:'POST',body:form,signal:controller.signal});if(!r.ok)throw Error('电话语音识别暂不可用');const j=await r.json(),text=String(j.text||'').trim();if(!text||text.length>1000)throw Error('没有听清');return text;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
const pcmCache=new Map();
async function speakPcm(text,signal,selection){
 const voice=profiles.resolve(selection),cacheKey=voice.voice+'|'+voice.rate+'|'+text;
 if(pcmCache.has(cacheKey)){if(signal?.aborted)throw Error('语音合成已取消');return pcmCache.get(cacheKey);}
 const data=Buffer.from(await speak(text,signal,voice),'base64');
 if(signal?.aborted)throw Error('语音合成已取消');
 const rawPcm=await new Promise((resolve,reject)=>{
  const child=require('child_process').spawn('ffmpeg',['-v','error','-i','pipe:0','-t','45','-ar','8000','-ac','1','-f','s16le','pipe:1'],{windowsHide:true,stdio:['pipe','pipe','ignore']});
  const chunks=[];let size=0,settled=false;const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);err?reject(err):resolve(value);},abort=()=>child.kill(),timer=setTimeout(()=>child.kill(),10000);
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>720000)child.kill();else chunks.push(chunk);});child.stdin.on('error',()=>{});
  child.on('error',()=>finish(Error('电话音频转换不可用')));child.on('close',code=>signal?.aborted?finish(Error('电话音频转换已取消')):code===0&&size>0?finish(null,Buffer.concat(chunks)):finish(Error('电话音频转换失败')));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();child.stdin.end(data);
 });
 if(signal?.aborted)throw Error('语音合成已取消');
 const pcm=require('./telephone-speech').trimTail(rawPcm);
 // Exact fixed phrases only: never retain a patient's words behind a generic prefix.
 if(require('./telephone-phrases').cacheable(text)){if(pcmCache.size>=128)pcmCache.delete(pcmCache.keys().next().value);pcmCache.set(cacheKey,pcm);}
 return pcm;
}
async function warmTelephone(){
 const texts=[...require('./telephone-phrases').warm];
 await Promise.all([0,1].map(async()=>{while(texts.length)await speakPcm(texts.shift());}));
}
module.exports={recognize,speak,recognizePcm,speakPcm,warmTelephone};
