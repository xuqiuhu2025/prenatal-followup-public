'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),net=require('node:net'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('../server/node_modules/@electric-sql/pglite');
const {Store}=require('../server/telephony-store'),{Ami}=require('../server/telephony-ami');
const {frame,Parser,uuid,wav,Vad}=require('../server/telephony-audio');
const D=require('../server/followup-dialogue');
const {PhoneSession}=require('../server/telephony-session');
const {Telephone}=require('../server/telephony');
async function fixture(){
 const pg=new PGlite();for(const f of ['04-hospital.sql','05-accounts.sql','06-prenatal.sql','07-telephone.sql'])await pg.exec(fs.readFileSync(path.join(__dirname,'../init',f),'utf8'));
 const query=async(sql,params=[])=>{const r=await pg.query(sql,params);return r.rows;};
 const db={q:query,withTransaction:fn=>pg.transaction(tx=>fn({query:(sql,params=[])=>tx.query(sql,params)}))};
 const account=(await query("INSERT INTO staff_accounts(username,display_name,role,password_hash) VALUES('qa','测试医护','staff','hash') RETURNING id"))[0];
 const store=new Store(db),config={allowlist:['13812345678','13912345678'],maxConcurrent:1};
 return {pg,db,query,account,store,config,close:()=>pg.close()};
}
const request=(e={})=>({requestId:crypto.randomUUID(),recordedBy:1,stage:'postnatal',count:1,authorized:true,...e});
async function waitUntil(check){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.ok(check(),'telephone operation did not settle');}

test('telephone startup warms the real opening and consent before advertising readiness',async()=>{
 const spoken=[],A=require('../server/followup-agent');
 const tel=new Telephone({config:{enabled:true,center:'测试中心',allowlist:[],startHour:9,endHour:18},agent:{...A,available:()=>true},speech:{async speakPcm(text){spoken.push(text);return Buffer.alloc(320);}},ami:{ready:true}});
 tel.listening=true;assert.equal(tel.status().automaticDial,false);await tel.prepareAudio();
 assert.equal(tel.status().automaticDial,true);assert.equal(spoken.length,3);assert.match(spoken[1],/供中心医护核对/);
 assert.ok(spoken.every(x=>!/演练|试玩/.test(x)));assert.equal(tel.consentAudio.length,320);
});
test('migrations persist a redacted call, lifecycle and reviewed follow-up draft',async t=>{
 const f=await fixture();t.after(f.close);const call=await f.store.create(request({phone:'13812345678'}),f.config);assert.equal(call.row.status,'dialing');
 await f.store.answered(call.row.id);await f.store.event(call.row.id,'media_connected');const draft={verified:false,outcome:'needs_review',transcript:[{role:'user',text:'我是本人'}],answers:[]};
 await f.store.finish(call.row.id,'interrupted','gateway_disconnected',draft);await f.store.eventByCallId(call.row.id,'call_ended',{status:'interrupted'});await f.store.finish(call.row.id,'ended','duplicate_event',draft);
 await f.store.finish(call.row.id,'interrupted','late_retry',{outcome:'declined'});
 const detail=await f.store.detail(call.row.id);assert.equal(detail.call.status,'interrupted');assert.equal(detail.call.reason,'gateway_disconnected');assert.equal(detail.call.draft.verified,false);assert.equal(detail.events.filter(x=>x.kind==='ended').length,1);assert.equal(detail.events.filter(x=>x.kind==='call_ended').length,1);assert.equal(detail.call.phone,'138****5678');
 await assert.rejects(f.store.review({id:call.row.id,recordedBy:f.account.id,note:''}),/处理说明/);await f.store.review({id:call.row.id,recordedBy:f.account.id,note:'请医护核实儿童复查情况'});
 assert.deepEqual(await f.store.review({id:call.row.id,recordedBy:f.account.id,note:'重复提交'}),{ok:true});
 assert.equal((await f.query('SELECT count(*)::int n FROM telephone_review_audit WHERE call_id=$1',[call.row.id]))[0].n,1);
});
test('call requests enforce consent, number allowlist, active-call limits, idempotency and STOP',async t=>{
 const f=await fixture();t.after(f.close);const e=request({phone:'13812345678'}),first=await f.store.create(e,f.config),retry=await f.store.create(e,f.config);assert.equal(retry.existing,true);assert.equal(retry.row.id,first.row.id);
 await assert.rejects(f.store.create({...e,count:2},f.config),/请求内容已改变/);await assert.rejects(f.store.create(request({phone:'13700000000'}),f.config),/授权试拨清单/);
 await assert.rejects(f.store.create(request({phone:'13912345678',authorized:false}),f.config),/同意/);await assert.rejects(f.store.create(request({phone:'13912345678'}),f.config),/正在进行/);
 await f.store.finish(first.row.id,'ended','do_not_call',{outcome:'declined'});await f.store.suppress(first.row.id,'13812345678');await assert.rejects(f.store.create(request({phone:'13812345678'}),f.config),/停止机器人来电/);await f.store.db.q('DELETE FROM telephone_suppressions WHERE phone=$1',['13812345678']);await assert.rejects(f.store.create(request({phone:'13812345678'}),f.config),/停止机器人来电/);
 const next=await f.store.create(request({phone:'13912345678'}),f.config);await f.store.finish(next.row.id,'ended','remote_hangup',{});
});
test('patient-linked calls accept only active pending postpartum phone tasks without demo identifiers',async t=>{
 const f=await fixture();t.after(f.close);const patient=(await f.query("INSERT INTO patients(patient_no,name,phone) VALUES('QA-1','测试产妇','13812345678') RETURNING id"))[0];
 const c=(await f.query("INSERT INTO prenatal_cases(patient_id,pregnancy_no,fetus_count) VALUES($1,'P-1',1) RETURNING id",[patient.id]))[0];
 const task=(await f.query("INSERT INTO followup_tasks(patient_id,title,due_date,assigned_to,channel,plan_key,prenatal_case_id,project_code,stage_code) VALUES($1,'产后随访',CURRENT_DATE,'医生','phone',$2,$3,'screen_follow','postnatal') RETURNING id",[patient.id,crypto.randomUUID(),c.id]))[0];
 const created=await f.store.create(request({taskId:String(task.id)}),f.config);assert.equal(created.row.phone,'13812345678');assert.equal(created.row.task_id,task.id);await f.store.finish(created.row.id,'ended','remote_hangup',{});
 await f.query("UPDATE patients SET patient_no='DEMO-1' WHERE id=$1",[patient.id]);await assert.rejects(f.store.create(request({taskId:String(task.id)}),f.config),/演示档案不得拨打/);
});
test('AudioSocket parser handles fragmentation, 8 kHz PCM and speech barge-in',()=>{
 const items=[],parser=new Parser((type,data)=>items.push({type,data})),id=crypto.randomUUID(),pcm=Buffer.alloc(320,7),packet=frame(1,Buffer.from(id.replaceAll('-',''),'hex'));
 parser.push(packet.subarray(0,5));assert.equal(items.length,0);parser.push(packet.subarray(5));parser.push(frame(0x10,pcm));assert.equal(uuid(items[0].data),id);assert.equal(items[1].data.length,320);assert.equal(wav(pcm,8000).readUInt32LE(24),8000);
 const vad=new Vad({threshold:500,silenceMs:400}),voice=Buffer.alloc(320);for(let i=0;i<160;i++)voice.writeInt16LE(6000,i*2);let barge=0,utterance=null;vad.on('speech',()=>barge++);vad.on('utterance',b=>utterance=b);vad.push(Buffer.concat([Buffer.alloc(320),...Array(6).fill(voice)]));assert.equal(barge,1);for(let i=0;i<20&&!utterance;i++)vad.push(Buffer.alloc(320));assert.ok(utterance?.length>=6*320);
 assert.throws(()=>uuid(Buffer.alloc(5)));assert.throws(()=>frame(1,Buffer.alloc(65536)));
});
test('AMI sample permissions allow originate, with separate Variable headers and wire events',async t=>{
 const manager=fs.readFileSync(path.join(__dirname,'../telephony/manager.conf.example'),'utf8');
 const permissions=/^write\s*=\s*(.+)$/m.exec(manager)[1].split(',').map(x=>x.trim());
 let buffer='',packets=[];const server=net.createServer(socket=>{socket.write('Asterisk Call Manager/5.0\r\n\r\n');socket.on('data',data=>{buffer+=data.toString();let end;while((end=buffer.indexOf('\r\n\r\n'))>=0){const packet=buffer.slice(0,end);buffer=buffer.slice(end+4);packets.push(packet);const id=/ActionID: ([^\r\n]+)/.exec(packet)?.[1],originate=packet.includes('Action: Originate');if(id){const allowed=!originate||permissions.includes('originate');socket.write('Response: '+(allowed?'Success':'Error')+'\r\nActionID: '+id+'\r\n\r\n');if(originate&&allowed)socket.write('Event: OriginateResponse\r\nResponse: Failure\r\nActionID: '+id+'\r\nReason: 5\r\n\r\n');}}});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const ami=new Ami({host:'127.0.0.1',port:server.address().port,username:'qa',secret:'secret',trunk:'hosp',prefix:'',callerId:'01012345678',ringMs:30000,mediaTarget:'cs-app:9092',maxMs:480000});t.after(()=>ami.stop());ami.start();
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('AMI login timeout')),1000);ami.once('ready',()=>{clearTimeout(timer);resolve();});});const id=crypto.randomUUID();
 const events=[];ami.on('event',e=>events.push(e));await ami.dial({id,phone:'13812345678'});
 await waitUntil(()=>events.length===1);assert.equal(events[0].Reason,'5');assert.equal(events[0].ActionID,id);
 const packet=packets.find(x=>x.includes('Action: Originate'));assert.match(packet,/Channel: PJSIP\/13812345678@hosp/);assert.match(packet,/Variable: FOLLOWUP_ID=/);assert.equal((packet.match(/Variable:/g)||[]).length,3);
 ami.stop();
});
test('AMI originate control reasons are distinct from Hangup cause codes',async()=>{
 const cases=[
  ['OriginateResponse','5','busy'],['OriginateResponse','3','no_answer'],['OriginateResponse','0','failed'],['OriginateResponse','1','failed'],['OriginateResponse','8','failed'],['OriginateResponse','17','failed'],
  ['Hangup','17','busy'],['Hangup','18','no_answer'],['Hangup','19','no_answer'],['Hangup','34','failed'],['Hangup','5','failed']
 ];
 for(const [event,code,status] of cases){
  const id=crypto.randomUUID(),finished=[],tel=new Telephone({config:{enabled:false},store:{async eventByCallId(){},async finish(...args){finished.push(args);}},agent:{},speech:{},ami:{async hangup(){}}});
  const call={row:{id},channel:'PJSIP/test',uniqueId:null,session:null,finished:false};tel.active.set(id,call);
  await tel.event(event==='OriginateResponse'?{Event:event,Response:'Failure',ActionID:id,Reason:code}:{Event:event,Uniqueid:id,Cause:code});
  await waitUntil(()=>finished.length);
  assert.equal(finished[0][1],status,event+' code '+code);assert.equal(call.finished,true);assert.equal(tel.persisting.size,0);
 }
});

test('generic originate failure arriving before the busy cause is settled once as busy',async()=>{
 const id=crypto.randomUUID(),finished=[],tel=new Telephone({config:{enabled:false},store:{async eventByCallId(){},async finish(...args){finished.push(args);}},agent:{},speech:{},ami:{async hangup(){}}});
 tel.active.set(id,{row:{id},channel:null,session:null,finished:false});
 await tel.event({Event:'OriginateResponse',Response:'Failure',ActionID:id,Reason:'0'});
 assert.equal(finished.length,0);
 await tel.event({Event:'Hangup',Uniqueid:id,Cause:'17'});await waitUntil(()=>finished.length);
 assert.equal(finished.length,1);assert.equal(finished[0][1],'busy');assert.equal(finished[0][2],'hangup_17');
 await tel.event({Event:'OriginateResponse',Response:'Failure',ActionID:id,Reason:'0'});assert.equal(finished.length,1);
});
test('telephone dialog saves verbatim turns and a review-only draft',async t=>{
 const pcm=Buffer.alloc(640,3),transcript=[],drafts=[],replies=['我是本人','同意'];let closed;
 const socket=new EventEmitter();Object.assign(socket,{destroyed:false,writableLength:0,write(){return true;},end(){this.destroyed=true;},destroy(){this.destroyed=true;}});
 const agent={create(stage,count,options){return {stage,count,mode:options.mode,phase:'identity',history:[{role:'assistant',text:D.opening(options)}],done:false,outcome:'in_progress'};},snapshot(s){return {...s,answers:[],draft:{review:[],deferred:[],verified:false}};},async advance(s,text){s.history.push({role:'user',text});transcript.push(text);s.phase=s.phase==='identity'?'consent':'questions';const reply=s.phase==='consent'?D.phoneReply(s,'现在方便聊几句吗？这是演练，您可以随时停下来。'):'妈妈最近恢复得怎么样？';s.history.push({role:'assistant',text:reply});return {reply,done:false};}};
 const speech={async recognizePcm(){return replies.shift();},async speakPcm(){return pcm;}},store={async answered(){},async event(){},async draft(id,d){drafts.push(structuredClone(d));},async suppress(){}};
 const config={center:'中心',vadThreshold:500,silenceMs:400,maxMs:5000};const call=new PhoneSession({row:{id:crypto.randomUUID(),stage:'postnatal',fetus_count:1,phone:'13812345678'},socket,config,agent,speech,store,openingAudio:pcm,consentAudio:pcm,onClose:async(...args)=>{closed=args;}});
 const utterance=async()=>{const voice=Buffer.alloc(320);for(let i=0;i<160;i++)voice.writeInt16LE(6000,i*2);for(let i=0;i<6;i++)call.receive(0x10,voice);for(let i=0;i<22;i++)call.receive(0x10,Buffer.alloc(320));};
 await call.start();await utterance();for(let i=0;i<50&&transcript.length<1;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(transcript,['我是本人']);assert.match(call.state.history[0].text,/AI随访助手/);assert.doesNotMatch(call.state.history[0].text,/演练/);
 await new Promise(resolve=>setTimeout(resolve,80));await utterance();for(let i=0;i<50&&transcript.length<2;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(transcript,['我是本人','同意']);assert.ok(drafts.some(d=>d.history?.some(x=>x.text==='同意')));assert.ok(call.metrics.length>=2);
 await call.close('ended','remote_hangup');assert.equal(closed[0],'ended');assert.equal(closed[2].verified,false);assert.equal(closed[2].outcome,'needs_review');
});
test('speaking during model and TTS work keeps the latest caller turn ahead of the stale prompt',async t=>{
 const pcm=Buffer.alloc(640,3),deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};},queued=[],complete=deferred();
 const socket=new EventEmitter();Object.assign(socket,{destroyed:false,writableLength:0,write(){return true;},end(){this.destroyed=true;},destroy(){this.destroyed=true;}});
 const agent={create(){return {stage:'postnatal',count:1,mode:'telephone',phase:'questions',history:[{role:'assistant',text:'宝宝几个月了？'}],done:false,outcome:'in_progress'};},snapshot(s){return {...s,answers:[],draft:{review:[],deferred:[],verified:false}};},async advance(s,text){queued.push(text);if(queued.length===1)await complete.promise;s.history.push({role:'user',text},{role:'assistant',text:queued.length===1?'旧问题':'新问题'});return {reply:queued.length===1?'旧问题':'新问题',done:false};}};
 const tts=deferred(),ttsCalls=[],speech={async recognizePcm(){return '正在回答';},async speakPcm(text){ttsCalls.push(text);if(text==='旧问题')await tts.promise;return pcm;}};
 const store={async answered(){},async event(){},async draft(){},async suppress(){}};let closed;
 const call=new PhoneSession({row:{id:crypto.randomUUID(),stage:'postnatal',fetus_count:1,phone:'13812345678'},socket,config:{center:'中心',vadThreshold:500,silenceMs:400,maxMs:8000},agent,speech,store,openingAudio:pcm,onClose:async(...args)=>{closed=args;}});
 const utterance=()=>{const voice=Buffer.alloc(320);for(let i=0;i<160;i++)voice.writeInt16LE(6000,i*2);for(let i=0;i<6;i++)call.receive(0x10,voice);for(let i=0;i<22;i++)call.receive(0x10,Buffer.alloc(320));};
 await call.start();utterance();for(let i=0;i<50&&!call.modelPending;i++)await new Promise(r=>setTimeout(r,10));assert.equal(call.modelPending,true);
 complete.resolve();for(let i=0;i<50&&!ttsCalls.includes('旧问题');i++)await new Promise(r=>setTimeout(r,10));assert.ok(ttsCalls.includes('旧问题'));
 utterance();for(let i=0;i<50&&!call.queue.length;i++)await new Promise(r=>setTimeout(r,10));assert.equal(call.queue.length,1);tts.resolve();for(let i=0;i<50&&queued.length<2;i++)await new Promise(r=>setTimeout(r,10));assert.deepEqual(queued,['正在回答','正在回答，正在回答']);
 await new Promise(r=>setTimeout(r,120));assert.ok(ttsCalls.includes('新问题'));assert.ok(call.transcript.filter(x=>x.role==='user').length>=2);
 await call.close('ended','test_complete');assert.equal(closed[0],'ended');
});
test('wrong-party and explicit permission refusals suppress future calls to that phone',()=>{
 for(const text of ['不是本人','打错了','没有授权','不同意随访','不要再打了'])assert.equal(require('../server/telephony-session').noMoreCalls(text),true,text);
 assert.equal(require('../server/telephony-session').noMoreCalls('现在不方便，明天下午再联系'),false);
 assert.equal(require('../server/telephony-session').noMoreCalls('不是本人，我是她同意代答的家属'),false);
 assert.equal(require('../server/telephony-session').noMoreCalls('我们不同意做羊穿检查'),false);
});

test('a request to call another time ends politely without becoming a permanent opt-out',async t=>{
 const f=controlledCall(t,{recognizePcm:async()=> '现在不方便，明天下午再联系'});let suppressions=0;f.call.store.suppress=async()=>{suppressions++;};
 await f.call.start();f.utterance();await waitUntil(()=>f.finals.length);
 assert.equal(f.finals[0][2].outcome,'callback_requested');assert.equal(suppressions,0);assert.equal(f.inputs.length,0);
 assert.ok(f.finals[0][2].transcript.some(x=>x.role==='user'&&x.text.includes('明天下午')));
});

test('recovered urgent calls retain review priority and idempotent retry returns the existing call',async t=>{
 const f=await fixture();t.after(f.close);const e=request({phone:'13812345678'}),first=await f.store.create(e,f.config);
 await f.store.draft(first.row.id,{outcome:'urgent',verified:false});await f.store.recover();
 const after=(await f.store.detail(first.row.id)).call;assert.equal(after.status,'interrupted');assert.equal(after.outcome,'urgent');assert.equal(after.priority,'urgent');
 assert.equal((await f.store.create(e,f.config)).existing,true);
});
function controlledCall(t,{advance,speakPcm,recognizePcm}={}){
 const pcm=Buffer.alloc(320),inputs=[],drafts=[],finals=[];
 const socket=new EventEmitter();Object.assign(socket,{destroyed:false,writableLength:0,write(){return true;},end(){this.destroyed=true;},destroy(){this.destroyed=true;}});
 const agent={
  create(){return {stage:'postnatal',count:1,mode:'telephone',phase:'questions',history:[{role:'assistant',text:'宝宝近况怎么样？'}],done:false,outcome:'in_progress'};},
  snapshot(s){return structuredClone({...s,answers:[],draft:{verified:false}});},
  async advance(s,text,options){inputs.push(text);if(advance)return advance(s,text,options);s.history.push({role:'user',text},{role:'assistant',text:'下一题'});return {reply:'下一题',done:false};}
 };
 const store={async answered(){},async event(){},async suppress(){},async draft(id,d){drafts.push(structuredClone(d));}};
 const call=new PhoneSession({row:{id:crypto.randomUUID(),stage:'postnatal',fetus_count:1,phone:'13812345678'},socket,config:{center:'测试中心',vadThreshold:500,silenceMs:400,maxMs:5000},agent,store,
  speech:{recognizePcm:recognizePcm||async function(){return '宝宝两个月';},speakPcm:speakPcm||async function(){return pcm;}},openingAudio:pcm,onClose:async(...args)=>{finals.push(structuredClone(args));}});
 t.after(()=>call.close('ended','test_cleanup'));
 const utterance=()=>{const voice=Buffer.alloc(320);for(let i=0;i<160;i++)voice.writeInt16LE(6000,i*2);for(let i=0;i<6;i++)call.receive(0x10,voice);for(let i=0;i<22;i++)call.receive(0x10,Buffer.alloc(320));};
 return {call,utterance,inputs,drafts,finals,pcm};
}
test('barge-in aborts pending synthesis immediately and retains both caller answers',async t=>{
 let pendingSignal,ttsCount=0,asrCount=0;
 const f=controlledCall(t,{
  recognizePcm:async()=>++asrCount===1?'宝宝两个月':'刚才说错了，三个月',
  speakPcm:async(text,signal)=>{
   if(++ttsCount===1){pendingSignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));}
   return Buffer.alloc(320);
  }
 });
 await f.call.start();f.utterance();await waitUntil(()=>pendingSignal);f.utterance();
 assert.equal(pendingSignal.aborted,true,'caller speech must cancel synthesis before it finishes');
 await waitUntil(()=>f.inputs.length===2&&!f.call.busy);
 assert.deepEqual(f.inputs,['宝宝两个月','宝宝两个月，刚才说错了，三个月']);
 assert.equal(f.call.transcript.filter(x=>x.role==='assistant'&&x.text==='下一题').length,1);
 assert.deepEqual(f.call.state.history.filter(x=>x.role==='user').map(x=>x.text),[f.inputs[1]]);
});
test('synthesis failure keeps the recognized answer in the review history',async t=>{
 const f=controlledCall(t,{speakPcm:async()=>{throw Error('synthesis unavailable');}});
 await f.call.start();f.utterance();await waitUntil(()=>f.finals.length);
 const draft=f.finals[0][2];assert.equal(draft.outcome,'needs_review');
 assert.ok(draft.history.some(x=>x.role==='user'&&x.text==='宝宝两个月'));
 assert.ok(draft.transcript.some(x=>x.role==='user'&&x.text==='宝宝两个月'));
});
test('urgent symptoms stay prioritized when the emergency reply cannot be synthesized',async t=>{
 const f=controlledCall(t,{
  recognizePcm:async()=> '现在大量出血，头晕站不稳',
  advance:async(s,text)=>{s.done=true;s.outcome='urgent';s.history.push({role:'user',text},{role:'assistant',text:'请立即联系急诊或120。'});return {reply:'请立即联系急诊或120。',done:true};},
  speakPcm:async()=>{throw Error('synthesis unavailable');}
 });
 await f.call.start();f.utterance();await waitUntil(()=>f.finals.length);
 assert.equal(f.finals[0][2].outcome,'urgent');
 assert.ok(f.finals[0][2].transcript.some(x=>x.role==='user'&&x.text==='现在大量出血，头晕站不稳'));
});
test('hangup during understanding preserves the uncommitted answer for review',async t=>{
 const f=controlledCall(t,{advance:async(s,text,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))});
 await f.call.start();f.utterance();await waitUntil(()=>f.call.modelPending);await f.call.close('ended','remote_hangup');
 const draft=f.finals[0][2];assert.equal(draft.verified,false);assert.equal(draft.outcome,'needs_review');
 assert.deepEqual(draft.pendingTranscripts,['宝宝两个月']);
});
