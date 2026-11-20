'use strict';
const { Player,Vad,frame }=require('./telephony-audio');
const speechQueue=require('./telephone-speech');
const noMoreCalls=text=>/(?:不要|别|不用|不需要|停止)(?:再)?(?:给我)?(?:打(?:电话|了)?|来电)|不要再联系|别再联系|打错(?:了)?|没有授权|未授权|不同意(?:继续|随访)|拒绝(?:接听|随访)/.test(text)||/^(?:不是本人|不同意)[。！!，,\s]*$/.test(text);
const unavailableNow=text=>!noMoreCalls(text)&&/(?:现在|今天|这会儿).{0,8}(?:不方便|没空)|^(?:不方便|没空)|(?:明天|改天|稍后|晚点|下次|过会儿).{0,8}(?:联系|再打|打来|回访)|(?:正在|我在)(?:开车|忙|上班|开会)/.test(text);
const WAIT='稍等一下。';

class PhoneSession {
  constructor({row,socket,config,agent,speech,store,onClose,openingAudio,consentAudio}) {
    Object.assign(this,{row,socket,config,agent,speech,store,onClose,openingAudio,consentAudio});
    this.state=agent.create(row.stage,row.fetus_count,{mode:'telephone',center:config.center});
    this.player=new Player(socket);this.vad=new Vad({threshold:config.vadThreshold,silenceMs:config.silenceMs});
    this.version=0;this.queue=[];this.texts=[];this.transcript=[];this.metrics=[];this.busy=false;this.closed=false;this.speaking=false;this.robotSpeaking=false;this.modelPending=false;this.inflightText='';this.silences=0;this.failures=0;this.waitingPlayed=false;
    this.vad.on('speech',()=>{
      this.speaking=true;this.silences=0;clearTimeout(this.idle);clearTimeout(this.waiting);
      if(this.robotSpeaking||this.modelPending||this.outputPending){if(this.modelPending&&this.inflightText)this.texts.unshift(this.inflightText);this.inflightText='';this.version++;this.controller?.abort();this.cancelPlayback();}
    });
    this.vad.on('preview',(pcm,meta)=>{
      if(this.closed)return;this.preview?.controller.abort();
      const controller=new AbortController(),item={id:meta.id,controller};
      item.result=Promise.resolve().then(()=>this.speech.recognizePcm(pcm,controller.signal)).then(text=>({text}),error=>({error}));this.preview=item;
    });
    this.vad.on('resume',id=>{if(this.preview?.id===id){this.preview.controller.abort();this.preview=null;}});
    this.vad.on('utterance',(pcm,meta)=>{
      this.speaking=false;if(this.closed)return;
      if(this.queue.length>=3){void this.close('interrupted','audio_backlog');return;}
      pcm.turnTiming={speechEndedAt:Date.now()-(meta?.silenceMs||0),endpointMs:meta?.silenceMs||0};
      if(this.preview?.id===meta?.id){pcm.earlyRecognition=this.preview;this.preview=null;}
      this.queue.push(pcm);void this.drain();
    });
  }
  snapshot(){return {...this.agent.snapshot(this.state),...(this.urgentObserved?{outcome:'urgent'}:{}),verified:false,transcript:this.transcript,metrics:this.metrics,pendingTranscripts:[...(this.inflightText?[this.inflightText]:[]),...this.texts]};}
  cancelPlayback(){this.playRequest=(this.playRequest||0)+1;this.playController?.abort();this.player.stop();this.outputPending=false;this.robotSpeaking=false;}
  persistSoon(){clearTimeout(this.persistTimer);this.persistTimer=setTimeout(()=>{if(!this.closed)void this.store.draft(this.row.id,this.snapshot()).catch(()=>{});},300);this.persistTimer.unref();}
  preserveTurn(text){if(text&&this.texts[0]!==text)this.texts.unshift(text);this.pendingTurn=false;this.modelPending=false;this.inflightText='';}
  async start(){
    try{
      this.limit=setTimeout(()=>void this.close('interrupted','duration_limit'),this.config.maxMs);
      const generation=this.version;await this.store.answered(this.row.id);await this.store.event(this.row.id,'media_connected');
      if(this.closed)return;
      await this.say(this.state.history[0].text,generation,this.openingAudio);
    }catch{await this.close('failed','opening_failed');}
  }
  receive(type,data){
    if(this.closed)return;
    if(type===0x00){void this.close('ended','remote_hangup');return;}
    if(type===0x03&&data.length===1&&data.toString()==='#'){
      this.state.done=true;this.state.outcome='declined';void this.close('ended','dtmf_stop');return;
    }
    if(type!==0x10){if(type!==0x03)void this.close('interrupted','unsupported_audio');return;}
    try{this.vad.push(data);}catch{void this.close('interrupted','invalid_audio');}
  }
  async say(text,generation,readyAudio,prepared,metric){
    if(this.closed||generation!==this.version)return false;
    clearTimeout(this.idle);const request=(this.playRequest||0)+1;this.playRequest=request;
    this.playController=new AbortController();this.outputPending=true;
    const sequence=prepared||speechQueue.prepare(this.speech,text,this.playController.signal,readyAudio);let entry,played=true;
    try{for(let i=0;i<sequence.parts.length;i++){
      const audio=i===0&&readyAudio?readyAudio:await sequence.at(i);
      if(this.closed||generation!==this.version||request!==this.playRequest){played=false;break;}
      if(!entry){entry={role:'assistant',text,at:new Date().toISOString(),delivery:'playing',spokenParts:[]};this.transcript.push(entry);
        if(metric){metric.firstPlaybackAt=Date.now();metric.fromSpeechEndMs=metric.firstPlaybackAt-metric.speechEndedAt;}
      }
      this.robotSpeaking=true;played=await this.player.play(audio);if(request===this.playRequest)this.robotSpeaking=false;
      if(!played)break;entry.spokenParts.push(sequence.parts[i]);
    }}catch(error){played=false;throw error;}finally{
      if(entry)entry.delivery=played?'played':'interrupted';
      if(request===this.playRequest){this.outputPending=false;this.robotSpeaking=false;}
      if(!this.closed&&generation===this.version&&!this.state.done)this.listen();
    }
    return played;
  }
  listen(){
    clearTimeout(this.idle);
    this.idle=setTimeout(async()=>{
      if(this.closed||this.busy||this.speaking)return;
      try{if(++this.silences>=2){await this.say('这边暂时没有听到您的回答，今天先到这里，再见。',this.version);await this.close('ended','silence_timeout');}
      else await this.say('您还在听吗？方便的话请说一句，不方便也可以直接挂断。',this.version);}
      catch{await this.close('failed','tts_failed');}
    },15000);
  }
  async drain(){
    if(this.busy||this.closed||this.speaking)return;
    this.busy=true;clearTimeout(this.idle);
    try{while(this.queue.length&&!this.closed&&!this.speaking){
      if(this.state.done){await this.close('ended','dialogue_finished');break;}
        const pcm=this.queue.shift(),generation=this.version,started=Date.now();
        this.pendingTurn=true;
      this.controller=new AbortController();let recognized=false;
      try{
        let early;
        if(pcm.earlyRecognition){const cancel=()=>pcm.earlyRecognition.controller.abort();this.controller.signal.addEventListener('abort',cancel,{once:true});
          try{early=await pcm.earlyRecognition.result;}finally{this.controller.signal.removeEventListener('abort',cancel);}
        }
        const text=early?.text||await this.speech.recognizePcm(pcm,this.controller.signal);recognized=true;
        if(this.closed)return;
        this.transcript.push({role:'user',text,at:new Date().toISOString()});this.texts.push(text);
        // An opt-out must be kept even if it arrives while a previous reply is cancelled.
        if(noMoreCalls(text))await this.store.suppress(this.row.id,this.row.phone);
        await this.store.draft(this.row.id,this.snapshot());
        if(noMoreCalls(text)){this.texts=[];this.state.done=true;this.state.outcome='declined';this.state.history.push({role:'user',text},{role:'assistant',text:'好的，今天先聊到这里。'});await this.store.draft(this.row.id,this.snapshot());await this.close('ended','do_not_call');break;}
        if(unavailableNow(text)){
          this.state.history.push({role:'user',text});this.texts=[];this.state.done=true;this.state.outcome='callback_requested';
          const reply='好的，今天先不打扰您。方便联系的时间会留给医护确认，谢谢您接听。';this.state.history.push({role:'assistant',text:reply});
          await this.store.draft(this.row.id,this.snapshot());await this.say(reply,this.version);await this.close('ended','callback_requested');break;
        }
        if(generation!==this.version){this.persistSoon();continue;}
        if(this.texts.join('，').length>1000){await this.close('interrupted','long_answer');break;}
        if(this.queue.length||this.speaking)continue;
        const asrMs=Date.now()-started,turnText=this.texts.join('，');this.texts=[];this.inflightText=turnText;this.pendingTurn=true;this.modelPending=true;const next=structuredClone(this.state);
        // One prerecorded acknowledgement if processing takes time; never loop it.
        this.waitingPlayed=false;this.waitingTask=null;this.waitingGeneration=generation;this.waiting=setTimeout(()=>{if(!this.closed&&generation===this.version&&!this.speaking){this.waitingPlayed=true;this.waitingTask=this.say(WAIT,generation).catch(()=>{});}},2400);
        // Keep the pending turn cancellable until both understanding and synthesis finish.
        const reply=await this.agent.advance(next,turnText,{signal:this.controller.signal});
        clearTimeout(this.waiting);
        // Finish an acknowledgement already on the line, while the answer is
        // synthesized in parallel. Never cut it mid-word just because the model finished.
        const acknowledgement=this.robotSpeaking?this.waitingTask:null;if(!acknowledgement)this.cancelPlayback();
        if(this.closed)continue;
        // Clinical review priority must not depend on successful voice playback.
        if(next.outcome==='urgent'){this.urgentObserved=true;await this.store.draft(this.row.id,this.snapshot());}
        if(generation!==this.version){this.preserveTurn(turnText);this.failures=0;await this.store.draft(this.row.id,this.snapshot());continue;}
        const modelMs=Date.now()-started-asrMs;
        const synthesisStart=Date.now(),sequence=speechQueue.prepare(this.speech,reply.reply,this.controller.signal,this.state.phase==='identity'&&next.phase==='consent'?this.consentAudio:undefined),audio=await sequence.at(0);
        const metric={asrMs,modelMs,ttsMs:Date.now()-synthesisStart,toAudioMs:Date.now()-started,earlyAsr:!!early?.text,engine:next.engine,modelTiming:next.engine==='ai'||next.engine==='fallback'?next.modelTiming:undefined,...pcm.turnTiming};this.metrics.push(metric);
        if(acknowledgement)await acknowledgement;
        if(this.closed)continue;
        if(generation!==this.version){this.preserveTurn(turnText);this.persistSoon();continue;}
        this.modelPending=false;this.inflightText='';
        if(this.queue.length||this.speaking){this.texts.unshift(turnText);continue;}
        this.state=next;this.texts=[];this.pendingTurn=false;this.failures=0;
        await this.store.draft(this.row.id,this.snapshot());
        if(this.closed)return;
        if(generation===this.version)await this.say(reply.reply,generation,audio,sequence,metric);
        if(this.state.done)await this.close('ended','dialogue_finished');
      }catch(error){
        clearTimeout(this.waiting);this.cancelPlayback();
        if(this.closed)return;
        if(generation!==this.version){const previous=this.inflightText;this.modelPending=false;this.pendingTurn=false;this.inflightText='';if(recognized){this.preserveTurn(previous);this.persistSoon();}else if(!this.closed)this.queue.unshift(pcm);continue;}
        this.pendingTurn=false;
        const unsavedText=this.inflightText||this.texts.join('，');if(unsavedText)this.state.history.push({role:'user',text:unsavedText});
        this.engineMessage=error?.message==='没有听清'?'抱歉，刚才没有听清。今天先到这里，之后可通过医院官方渠道联系中心。':'刚才的回答已保留，但我这会儿没法完整整理。之后可以请中心医护跟进。';
        this.state.history.push({role:'assistant',text:this.engineMessage});this.texts=[];this.inflightText='';this.modelPending=false;this.state.done=true;this.state.outcome='needs_review';this.persistSoon();
        try{await this.say(this.engineMessage,this.version);await this.close('interrupted',error?.message==='没有听清'?'asr_unclear':'processing_failed');}catch{await this.close('failed','tts_failed');}
      }
    }}finally{this.busy=false;if(!this.closed&&!this.speaking){if(this.queue.length)void this.drain();else this.listen();}}
  }
  async close(status,reason){
    if(this.closed)return this.finishing;
    this.preserveTurn(this.inflightText);
    this.closed=true;this.version++;this.controller?.abort();this.pendingTurn=false;this.modelPending=false;this.inflightText='';this.robotSpeaking=false;this.cancelPlayback();clearTimeout(this.idle);clearTimeout(this.limit);clearTimeout(this.waiting);clearTimeout(this.persistTimer);
    this.preview?.controller.abort();for(const pcm of this.queue)pcm.earlyRecognition?.controller.abort();
    if(!this.state.done){this.state.done=true;this.state.outcome='needs_review';}
    if(!this.socket.destroyed){this.socket.end(frame(0x00));const timer=setTimeout(()=>this.socket.destroy(),1000);timer.unref();}
    const draft=this.snapshot();
    const saveDeadline=setTimeout(()=>{if(!this.saveSettled)this.onClose(status,reason,draft).catch(()=>{});},10000);saveDeadline.unref();
    this.finishing=Promise.resolve(this.onClose(status,reason,draft)).finally(()=>{this.saveSettled=true;clearTimeout(saveDeadline);});return this.finishing;
  }
}
module.exports={PhoneSession,noMoreCalls,WAIT};
