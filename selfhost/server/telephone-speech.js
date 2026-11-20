'use strict';
// Split only validated replies, never partial LLM JSON or a decimal number.
function split(text){
  const sentences=text.match(/[^。！？!?]+[。！？!?]?/g)||[text],parts=[];let part='';
  for(const sentence of sentences){part+=sentence;if((part.length>=18||/[？?]$/.test(part))&&parts.length<2){parts.push(part);part='';}}
  if(part)parts.push(part);return parts;
}
// Trim only sustained near-silence after the last audible 20 ms frame. Keep
// 160 ms of breathing room; do not touch leading audio or pauses inside a reply.
function trimTail(pcm){
  if(!Buffer.isBuffer(pcm)||pcm.length%2)return pcm;
  let end=pcm.length;
  while(end>=320){
    let sum=0,peak=0;
    for(let i=end-320;i<end;i+=2){const sample=pcm.readInt16LE(i);sum+=sample*sample;peak=Math.max(peak,Math.abs(sample));}
    if(Math.sqrt(sum/160)>16||peak>64)break;
    end-=320;
  }
  if(end<320||pcm.length-end<6400)return pcm;
  return pcm.subarray(0,end+2560);
}
function prepare(speech,text,signal,readyAudio){
  const parts=readyAudio?[text]:split(text);
  // Start the next sentence while the first is being prepared/played. Attach
  // rejection handlers immediately, including for a cancelled later sentence.
  const jobs=parts.map((part,i)=>Promise.resolve().then(()=>readyAudio&&i===0?readyAudio:speech.speakPcm(part,signal))
    .then(audio=>({audio}),error=>({error})));
  return {parts,async at(i){const result=await jobs[i];if(signal?.aborted)throw Error('语音播报已取消');if(result.error)throw result.error;return result.audio;}};
}
module.exports={split,prepare,trimTail};
