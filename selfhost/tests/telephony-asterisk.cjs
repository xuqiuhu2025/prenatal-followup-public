'use strict';
// Real Asterisk + SIP to itself on 127.0.0.1. This process has no carrier route.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const net=require('node:net'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const {PGlite}=require('../server/node_modules/@electric-sql/pglite');
const {Telephone}=require('../server/telephony'),{Store}=require('../server/telephony-store');
const {Parser,frame,Player}=require('../server/telephony-audio');
const Agent=require('../server/followup-agent');
const live=process.env.TELEPHONE_LAB_LIVE==='1';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const value=await check();if(value)return value;await delay(25);}throw Error('Asterisk lab operation timed out');}
const tone=(frequency,seconds)=>{const b=Buffer.alloc(Math.round(8000*seconds)*2);for(let i=0;i<b.length/2;i++)b.writeInt16LE(Math.round(6000*Math.sin(i*2*Math.PI*frequency/8000)),i*2);return b;};
const root=path.resolve(__dirname,'..');
let directory,asterisk,pg,tel,peerServer;const peerSockets=new Set(),amiEvents=[],results=[];
let asteriskLog='',peerBytes=0,inboundFrames=0,recognized=[],peerFailure='';const liveAudio=[];

async function setup(){
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'followup-asterisk-'));
 for(const part of ['etc','run','logs','lib','spool'])await fs.mkdir(path.join(directory,part));
 const secret=crypto.randomBytes(24).toString('hex');
 const paths={astetcdir:directory+'/etc',astmoddir:'/usr/lib/asterisk/modules',astvarlibdir:directory+'/lib',astdbdir:directory+'/lib',astkeydir:directory+'/lib',astdatadir:directory+'/lib',astagidir:directory+'/lib',astspooldir:directory+'/spool',astrundir:directory+'/run',astlogdir:directory+'/logs'};
 const conf='[directories]\n'+Object.entries(paths).map(([k,v])=>k+' => '+v).join('\n')+'\n[options]\nverbose=2\ndebug=0\n';
 const files={
  'asterisk.conf':conf,
  'modules.conf':'[modules]\nautoload=no\n'+['res_timing_timerfd','res_sorcery_config','res_sorcery_memory','res_sorcery_astdb','res_pjproject','res_pjsip','res_pjsip_session','res_pjsip_pubsub','res_pjsip_authenticator_digest','res_pjsip_outbound_authenticator_digest','res_pjsip_endpoint_identifier_ip','res_pjsip_endpoint_identifier_user','res_pjsip_sdp_rtp','res_pjsip_refer','res_rtp_asterisk','res_audiosocket','chan_pjsip','pbx_config','codec_alaw','codec_ulaw','codec_resample','app_audiosocket','app_playback','app_stack','func_timeout','func_channel','func_logic','res_clioriginate'].map(x=>'load='+x+'.so').join('\n')+'\n',
  'manager.conf':'[general]\nenabled=yes\nwebenabled=no\nport=5038\nbindaddr=127.0.0.1\n[lab]\nsecret='+secret+'\ndeny=0.0.0.0/0.0.0.0\npermit=127.0.0.1/255.255.255.255\nread=system,call\nwrite=call,originate\n',
  'logger.conf':'[logfiles]\nconsole=notice,warning,error,verbose\n',
  'rtp.conf':'[general]\nrtpstart=12000\nrtpend=12100\nice_support=no\n',
  'pjsip.conf':'[transport-lab]\ntype=transport\nprotocol=udp\nbind=127.0.0.1:5060\n[lab-aor]\ntype=aor\ncontact=sip:127.0.0.1:5060\n[lab-trunk]\ntype=endpoint\ntransport=transport-lab\ncontext=lab-recipient\ndisallow=all\nallow=alaw,ulaw\naors=lab-aor\ndirect_media=no\n[lab-identify]\ntype=identify\nendpoint=lab-trunk\nmatch=127.0.0.1\n',
  'extensions.conf':(await fs.readFile(path.join(root,'telephony/extensions.conf.example'),'utf8'))+'\n[lab-recipient]\nexten => 13800000001,1,Answer()\n same => n,AudioSocket(00000000-0000-4000-8000-000000000001,127.0.0.1:9093)\n same => n,Hangup()\nexten => 13800000002,1,Busy(1)\nexten => 13800000003,1,Ringing()\n same => n,Wait(30)\n same => n,Hangup()\n'
 };
 for(const [name,data]of Object.entries(files))await fs.writeFile(path.join(directory,'etc',name),data);
 asterisk=spawn('asterisk',['-f','-g','-C',directory+'/etc/asterisk.conf'],{stdio:['ignore','pipe','pipe']});
 asterisk.stdout.on('data',b=>{asteriskLog=(asteriskLog+b.toString()).slice(-16000);});asterisk.stderr.on('data',b=>{asteriskLog=(asteriskLog+b.toString()).slice(-16000);});
 await until(()=>new Promise(resolve=>{const s=net.createConnection(5038,'127.0.0.1');s.on('connect',()=>{s.destroy();resolve(true);});s.on('error',()=>resolve(false));}));
 pg=new PGlite();for(const name of ['04-hospital.sql','05-accounts.sql','06-prenatal.sql','07-telephone.sql'])await pg.exec(await fs.readFile(path.join(root,'init',name),'utf8'));
 const q=async(sql,params=[])=>params.length?(await pg.query(sql,params)).rows:(await pg.exec(sql)).at(-1).rows;
 const store=new Store({q,withTransaction:fn=>pg.transaction(tx=>fn({query:(sql,params=[])=>tx.query(sql,params)}))});
 await q("INSERT INTO staff_accounts(username,display_name,role,password_hash) VALUES('lab','虚构测试医护','staff','no-login')");
 // Static text is intentional: this test measures SIP/media behavior, not ASR/LLM quality.
 const texts=['我是本人','同意','我想找医生'];
 const realSpeech=live?require('../server/speech'):null;
 const speech={async recognizePcm(pcm,signal){assert.ok(pcm.length>1600);inboundFrames++;const text=live?await realSpeech.recognizePcm(pcm,signal):texts.shift();if(!text)throw Error('Unexpected speech segment');recognized.push(text);return text;},async speakPcm(text,signal){return live?realSpeech.speakPcm(text,signal):tone(660,.4);}};
 if(live){assert.ok(Agent.available(),'Live lab needs the existing model configuration');for(const text of ['我是本人。','同意。','妈妈恢复得还好。宝宝现在两个月，吃奶睡觉都挺好。','我想找医生。'])liveAudio.push(await realSpeech.speakPcm(text));}
 const config={enabled:true,host:'127.0.0.1',port:5038,username:'lab',secret,trunk:'lab-trunk',prefix:'',callerId:'4000000000',mediaHost:'127.0.0.1',mediaPort:9092,mediaTarget:'127.0.0.1:9092',peers:['127.0.0.1'],allowlist:['13800000001','13800000002','13800000003'],center:'虚构测试中心',ringMs:2500,maxMs:live?150000:25000,maxConcurrent:1,startHour:0,endHour:24,vadThreshold:600,silenceMs:500};
 tel=new Telephone({config,store,agent:{...Agent,available:()=>true},speech});
 peerServer=net.createServer(socket=>{
  peerSockets.add(socket);let authenticated=false;const player=new Player(socket);
  const sendAnswers=async()=>{
    if(live){for(let i=0;i<liveAudio.length&&!socket.destroyed;i++){
      await until(()=>{const s=[...tel.active.values()][0]?.session;return s&&(s.closed||s.transcript.filter(x=>x.role==='assistant'&&x.delivery==='played'&&x.text!==require('../server/telephony-session').WAIT).length>=i+1&&!s.busy&&!s.speaking);},45000);
      if(socket.destroyed)break;await delay(300);await player.play(Buffer.concat([liveAudio[i],Buffer.alloc(16000)]));
    }}else{await delay(900);for(let i=0;i<3&&!socket.destroyed;i++){await player.play(Buffer.concat([tone(440,.5),Buffer.alloc(16000)]));await delay(900);}}
  };
  const parser=new Parser((type,data)=>{if(type===1){authenticated=true;void sendAnswers().catch(e=>{peerFailure=e.message;socket.destroy();});}else if(type===0x10){assert.ok(authenticated);peerBytes+=data.length;}else if(type===0)socket.end();});
  socket.on('data',d=>{try{parser.push(d);}catch{socket.destroy();}});socket.on('error',()=>{});socket.on('close',()=>{player.stop();peerSockets.delete(socket);});
 });
 await new Promise(resolve=>peerServer.listen(9093,'127.0.0.1',resolve));await tel.start();tel.ami.on('event',e=>amiEvents.push(e));await until(()=>tel.status().automaticDial&&asteriskLog.includes('Asterisk Ready'),30000);
 return {q,store};
}
async function main(){
 const {q,store}=await setup();
 const call=phone=>tel.main({action:'calling_dial',requestId:crypto.randomUUID(),recordedBy:1,phone,stage:'postnatal',count:1,authorized:true});
 const answered=await call('13800000001');assert.equal(answered.ok,true,JSON.stringify(answered));
 const record=await until(async()=>{const r=await store.detail(answered.id);return r.call.ended_at?r.call:null;},live?160000:22000);
 if(live)results.push({case:'live_audio_turns',transcript:record.draft.transcript,metrics:record.draft.metrics,answers:record.draft.answers,model:require('../server/llm').MODEL_VOICE,peerFailure});
 assert.equal(record.status,'ended');assert.equal(record.outcome,'needs_review');assert.ok(record.answered_at);assert.equal(record.draft.verified,false);assert.ok(peerBytes>3200);
 if(live){assert.ok(inboundFrames>=4);assert.ok(record.draft.answers.some(x=>x.key==='maternal_recovery'));assert.ok(record.draft.answers.some(x=>x.key==='f1_health'));}else{assert.deepEqual(recognized,['我是本人','同意','我想找医生']);assert.equal(inboundFrames,3);}
 await store.review({id:answered.id,recordedBy:1,note:'内部SIP回环完成；受访者希望联系医护，留待人工处理。'});
 assert.equal((await store.detail(answered.id)).call.review_status,'reviewed');
 results.push({case:'sip_audio_review',status:record.status,outcome:record.outcome,recognizedTurns:recognized.length,receivedAudioBytes:peerBytes,verified:false});
 for(const [phone,expected]of [['13800000002','busy'],['13800000003','no_answer']]){
  const r=await call(phone);assert.equal(r.ok,true);const result=await until(async()=>{const row=(await store.detail(r.id)).call;return row.ended_at?row:null;});
  assert.equal(result.status,expected);assert.equal(result.answered_at,null);results.push({case:expected,status:result.status,reason:result.reason});
 }
 assert.equal((await q('SELECT count(*)::int n FROM followup_records'))[0].n,0);
 assert.equal(tel.active.size,0);
 results.push({case:'no_clinical_completion',records:0});
 const result={ok:true,asterisk:execFileSync('asterisk',['-V'],{encoding:'utf8'}).trim(),transport:'PJSIP loopback + RTP + AudioSocket',network:'SIP is container loopback only; no carrier',modelAndSpeech:live?'existing real ASR, TTS and LLM services':'deterministic test doubles',results};
 if(process.env.TELEPHONE_LAB_REPORT)await fs.writeFile(process.env.TELEPHONE_LAB_REPORT,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(JSON.stringify({ok:false,error:e.message,stack:e.stack,results,events:amiEvents.filter(e=>['OriginateResponse','Hangup'].includes(e.Event)).map(e=>({event:e.Event,response:e.Response,reason:e.Reason,cause:e.Cause,uniqueid:e.Uniqueid})),asteriskLog},null,2));process.exitCode=1;}).finally(async()=>{
 await tel?.stop();for(const s of peerSockets)s.destroy();if(peerServer?.listening)await new Promise(r=>peerServer.close(r));
 if(asterisk&&asterisk.exitCode===null){asterisk.kill('SIGTERM');const kill=setTimeout(()=>asterisk.kill('SIGKILL'),2000);await new Promise(r=>asterisk.once('exit',r));clearTimeout(kill);}await pg?.close();
});
