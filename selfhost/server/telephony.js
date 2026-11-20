'use strict';
const net=require('net'),{read,inHours}=require('./telephony-config'),{Ami}=require('./telephony-ami');
const {Parser,uuid:audioUuid}=require('./telephony-audio'),{Store,uuid}=require('./telephony-store');
const {PhoneSession,WAIT}=require('./telephony-session');

class Telephone {
  constructor({config,store,agent,speech,ami}={}){
    this.config=config||read();this.store=store;this.agent=agent||require('./followup-agent');this.speech=speech||require('./speech');
    this.ami=ami;this.active=new Map();this.persisting=new Map();this.listening=false;this.audioReady=false;this.started=false;
  }
  getStore(){return this.store||(this.store=new Store(require('./db')));}
  status(){
    const ready=this.config.enabled&&this.listening&&this.ami?.ready&&this.audioReady&&this.agent.available();
    return {automaticDial:!!ready,pilot:true,mode:ready?'telephone_pilot':'web_robot',
      reason:!this.config.enabled?'电话模块已安装，等待 SIP 线路与授权测试号码配置':!this.ami?.ready?'正在等待电话网关连接':!this.audioReady?'正在准备电话语音服务':!this.agent.available()?'对话理解模型未配置':!this.listening?'电话音频端口未就绪':'网关已连接，仅允许授权号码试拨；实际线路以试拨结果为准',
      gatewayConnected:!!this.ami?.ready,mediaReady:this.listening,audioReady:this.audioReady,
      allowedNumberCount:this.config.allowlist.length,activeCalls:this.active.size,
      callingHours:this.config.startHour+':00–'+this.config.endHour+':00（北京时间）'};
  }
  async start(){
    if(this.started)return;this.started=true;
    await this.getStore().ensureSchema();
    // Always reconcile unfinished jobs, including a restart with dialing disabled.
    await this.store.recover();
    if(!this.config.enabled)return;
    this.ami=this.ami||new Ami(this.config);
    this.ami.on('event',e=>void this.event(e).catch(()=>{}));
    this.ami.on('offline',()=>{for(const call of this.active.values())void this.end(call,'interrupted','gateway_disconnected');});
    this.server=net.createServer(socket=>this.accept(socket));this.server.maxConnections=this.config.maxConcurrent+4;
    this.server.on('error',()=>{this.listening=false;});
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.config.mediaPort,this.config.mediaHost,()=>{this.server.removeListener('error',reject);this.listening=true;resolve();});});
    this.ami.start();
    void this.prepareAudio();
    this.prepareTimer=setInterval(()=>{if(!this.audioReady)void this.prepareAudio();},60000);this.prepareTimer.unref();
  }
  async prepareAudio(){
    if(this.preparingAudio)return;this.preparingAudio=true;
    try{
      const s=this.agent.create('postnatal',1,{mode:'telephone',center:this.config.center});
      const intro=require('./followup-dialogue').opening({mode:'telephone',center:this.config.center});s.history[0].text=intro;this.opening=await this.speech.speakPcm(intro);
      this.consentAudio=await this.speech.speakPcm(require('./followup-dialogue').phoneReply(s,'现在方便聊几句吗？这是演练，您可以随时停下来。'));
      await this.speech.speakPcm(WAIT);await this.speech.warmTelephone?.();this.audioReady=true;
    }catch{this.audioReady=false;}finally{this.preparingAudio=false;}
  }
  async dial(e){
    if(!this.status().automaticDial)return {ok:false,code:'LINE_NOT_CONNECTED',error:this.status().reason};
    if(!inHours(this.config))throw Error('当前不在允许的拨打时段：'+this.status().callingHours);
    const {row,existing}=await this.getStore().create(e,this.config);
    if(existing)return {ok:true,id:row.id,status:row.status,reused:true};
    const call={row,channel:null,uniqueId:null,session:null,finished:false};this.active.set(row.id,call);
    call.ringTimer=setTimeout(()=>void this.end(call,'no_answer','ring_timeout'),this.config.ringMs+10000);
    try{await this.ami.dial({id:row.id,phone:row.phone});return {ok:true,id:row.id,status:'dialing'};}
    catch{await this.end(call,'failed','originate_failed');return {ok:false,id:row.id,error:'电话网关未确认本次拨号，请查看通话记录；不要立即重复拨打。'};}
  }
  accept(socket){
    const peer=(socket.remoteAddress||'').replace(/^::ffff:/,'');
    if(!this.config.peers.includes(peer)){socket.destroy();return;}
    socket.setNoDelay(true);socket.setTimeout(30000,()=>socket.destroy());
    let call=null,identified=false;const timeout=setTimeout(()=>socket.destroy(),5000);
    const parser=new Parser((type,data)=>{
      if(!identified){
        if(type!==1)throw Error('Missing UUID');identified=true;clearTimeout(timeout);
        call=this.active.get(audioUuid(data));
        if(!call||call.finished||call.session)throw Error('Unknown or duplicate call');
        clearTimeout(call.ringTimer);
        call.session=new PhoneSession({row:call.row,socket,config:this.config,agent:this.agent,speech:this.speech,store:this.getStore(),openingAudio:this.opening,consentAudio:this.consentAudio,onClose:(status,reason,draft)=>this.finish(call,status,reason,draft)});
        void call.session.start();
      }else call.session.receive(type,data);
    });
    socket.on('data',data=>{try{parser.push(data);}catch{socket.destroy();}});
    socket.on('error',()=>{});
    socket.on('close',()=>{clearTimeout(timeout);if(call?.session&&call.session.socket===socket)void call.session.close('ended','media_closed');});
  }
  async event(e){
    const call=this.active.get(e.ActionID)||this.active.get(e.Uniqueid)||[...this.active.values()].find(item=>item.uniqueId&&item.uniqueId===e.Uniqueid);if(!call||call.finished)return;
    if(e.Channel)call.channel=e.Channel;if(e.Uniqueid)call.uniqueId=e.Uniqueid;
    if(e.Event==='OriginateResponse'&&e.Response==='Failure'){
      // OriginateResponse uses AST_CONTROL_* values, unlike Hangup's Q.850 Cause.
      const status=e.Reason==='5'?'busy':e.Reason==='3'?'no_answer':'failed';
      if(!call.session)this.settleFailure(call,status,'originate_'+String(e.Reason||'unknown').slice(0,12));
    }else if(e.Event==='OriginateResponse'&&e.Response==='Success'&&e.Uniqueid){call.uniqueId=e.Uniqueid;}
    else if(e.Event==='Hangup'){
      const status=call.session?'ended':e.Cause==='17'?'busy':['18','19'].includes(e.Cause)?'no_answer':'failed';
      if(call.session)await this.end(call,status,'hangup_'+String(e.Cause||'unknown').slice(0,12));
      else this.settleFailure(call,status,'hangup_'+String(e.Cause||'unknown').slice(0,12));
    }
  }
  settleFailure(call,status,reason){
    // PJSIP can send OriginateResponse(0) before Hangup(17/19). Allow the cause
    // event to arrive before committing an immutable call result.
    if(!call.failure||status!=='failed')call.failure={status,reason};
    if(call.failureTimer)return;
    clearTimeout(call.ringTimer);
    call.failureTimer=setTimeout(()=>void this.end(call,call.failure.status,call.failure.reason),250);
  }
  async end(call,status,reason){
    if(call.finished)return;
    if(call.session)return call.session.close(status,reason);
    return this.finish(call,status,reason,{verified:false,outcome:'needs_review',history:[],answers:[]});
  }
  async finish(call,status,reason,draft){
    if(call.finished)return;call.finished=true;clearTimeout(call.ringTimer);clearTimeout(call.failureTimer);
    // ChannelId is set to our UUID; AMI accepts a channel name or uniqueid.
    try{await this.ami?.hangup(call.channel||call.uniqueId||call.row.id);}catch{}
    this.active.delete(call.row.id);
    const pending={id:call.row.id,status,reason,draft};this.persisting?.set(call.row.id,pending);
    try{await this.getStore().eventByCallId(call.row.id,'call_ended',{status,reason});}
    catch{const event={id:call.row.id,kind:'call_ended',detail:{status,reason}};this.persisting?.set('event:'+call.row.id,event);this.retryEvent(event);}
    await this.persist(pending);
  }
  retryEvent(event){const timer=setTimeout(async()=>{try{await this.getStore().eventByCallId(event.id,event.kind,event.detail);this.persisting?.delete('event:'+event.id);}catch{this.retryEvent(event);}},5000);timer.unref();}
  async persist(pending){
    try{await this.getStore().finish(pending.id,pending.status,pending.reason,pending.draft);this.persisting.delete(pending.id);}
    catch{pending.timer=setTimeout(()=>void this.persist(pending),5000);pending.timer.unref();}
  }
  async main(e){
    if(!e.recordedBy)throw Error('请先登录');
    if(e.action==='calling_dial')return this.dial(e);
    if(e.action==='calling_phone_list')return this.getStore().list(e);
    if(e.action==='calling_phone_audit')return this.getStore().reviewAudit(e);
    if(e.action==='calling_phone_detail')return this.getStore().detail(e.id);
    if(e.action==='calling_phone_review')return this.getStore().review(e);
    if(e.action==='calling_phone_stop'){
      if(!uuid(e.id))throw Error('通话编号无效');const call=this.active.get(e.id);if(call)await this.end(call,'cancelled','staff_stopped');return {ok:true};
    }
    return {ok:false,error:'未知电话操作'};
  }
  async stop(){clearInterval(this.prepareTimer);for(const c of this.active.values())await this.end(c,'interrupted','shutdown');this.ami?.stop();this.server?.close();this.listening=false;}
}
let singleton;const instance=()=>singleton||(singleton=new Telephone());
module.exports={Telephone,status:()=>instance().status(),start:()=>instance().start(),main:e=>instance().main(e)};
