'use strict';
// Softphone test: authenticated extensions, no carrier or clinical database route.
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {Telephone}=require('../../server/telephony'),Agent=require('../../server/followup-agent'),Speech=require('../../server/speech');
const {PRIVATE,PUBLIC,validatePublic,pjsipConfig}=require('./phone-config.cjs'),Provisioning=require('./provisioning.cjs');
const root=process.env.SOFTPHONE_DATA||'/data',pbx=path.join(root,'asterisk');
const publicIp=process.env.SOFTPHONE_SERVER_IP,clientIp=process.env.SOFTPHONE_CLIENT_IP;
let tel,asterisk,server,tlsFront,publicConfig,stopping=false,persistence=Promise.resolve();
const rows=new Map(),allowed=new Set(PRIVATE),stamp=()=>new Date().toISOString();
const opening='您好，我是产后随访测试助手。这是一次模拟通话，请用虚构信息回答。请问您是本人，还是经本人同意接听的家属？';
const agent={...Agent,create(...args){const state=Agent.create(...args);state.history[0].text=opening;return state;}};
const save=row=>{const snapshot=JSON.stringify(row,null,2);persistence=persistence.catch(()=>{}).then(async()=>{const file=path.join(root,'calls',row.id+'.json');await fs.writeFile(file+'.tmp',snapshot,{mode:0o600});await fs.rename(file+'.tmp',file);});return persistence;};
const store={
 async ensureSchema(){await fs.mkdir(path.join(root,'calls'),{recursive:true});},
 async recover(){for(const file of await fs.readdir(path.join(root,'calls'))){if(!/^[a-f0-9-]+\.json$/.test(file))continue;const row=JSON.parse(await fs.readFile(path.join(root,'calls',file),'utf8'));if(['dialing','answered'].includes(row.status)){Object.assign(row,{status:'interrupted',ended_at:stamp(),reason:'test_service_restarted'});await save(row);}rows.set(row.id,row);}},
 async answered(id){const row=rows.get(id);Object.assign(row,{status:'answered',answered_at:stamp()});await save(row);},
 async event(id,kind,detail={}){const row=rows.get(id);if(!row)return;row.events.push({at:stamp(),kind,detail});await save(row);},
 async eventByCallId(id,kind,detail){return this.event(id,kind,detail);},
 async draft(id,draft){const row=rows.get(id);row.draft=draft;await save(row);},
 async suppress(id){await this.event(id,'simulated_opt_out');},
 async finish(id,status,reason,draft){const row=rows.get(id);Object.assign(row,{status,reason,draft,outcome:draft.outcome,ended_at:stamp()});await save(row);}
};
async function prepare(extension,direction,channel){
 if(!allowed.has(extension))throw Error('Unknown test extension');
 if(!tel.status().automaticDial)throw Error('Robot warming up');
 if(tel.active.size)throw Error('A test call is already active');
 const row={id:crypto.randomUUID(),phone:extension,stage:'postnatal',fetus_count:1,status:'dialing',created_at:stamp(),direction,test_only:true,events:[]};
 const call={row,channel:channel||null,uniqueId:null,session:null,finished:false};tel.active.set(row.id,call);rows.set(row.id,row);
 try{await save(row);}catch(e){tel.active.delete(row.id);throw e;}
 call.ringTimer=setTimeout(()=>void tel.end(call,'no_answer','test_timeout'),45000);return call;
}
async function dial(extension){
 const call=await prepare(extension,'outbound');
 try{await tel.ami.action({Action:'Originate',ActionID:call.row.id,Channel:'PJSIP/'+extension,ChannelId:call.row.id,CallerID:'"Followup Robot" <7000>',Timeout:30000,Async:'true',Context:'followup-agent',Exten:'s',Priority:1,Variable:['FOLLOWUP_ID='+call.row.id,'FOLLOWUP_MEDIA=127.0.0.1:9092','FOLLOWUP_LIMIT=480']});return call.row.id;}
 catch(e){await tel.end(call,'failed','originate_failed');throw e;}
}
async function configFiles(){
 try{publicConfig=validatePublic(JSON.parse(await fs.readFile(path.join(root,'public-phone.json'),'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(publicConfig){for(const extension of PUBLIC)allowed.add(extension);await fs.access('/tls/fullchain.pem');await fs.access('/tls/privkey.pem');}
 if(!/^100\.(?:\d{1,3}\.){2}\d{1,3}$/.test(publicIp||'')||!/^100\.(?:\d{1,3}\.){2}\d{1,3}$/.test(clientIp||''))throw Error('Tailscale IPs required');
 for(const part of ['etc','run','logs','lib','spool'])await fs.mkdir(path.join(pbx,part),{recursive:true});
 let credentials;try{credentials=JSON.parse(await fs.readFile(path.join(root,'credentials.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;credentials={ami:crypto.randomBytes(24).toString('hex'),accounts:{}};}
 let credentialsChanged=false;for(const extension of allowed)if(!credentials.accounts[extension]){credentials.accounts[extension]=crypto.randomBytes(24).toString('hex');credentialsChanged=true;}
 if(credentialsChanged){const file=path.join(root,'credentials.json');await fs.writeFile(file+'.tmp',JSON.stringify(credentials),{mode:0o600});await fs.rename(file+'.tmp',file);}
 const paths={astetcdir:pbx+'/etc',astmoddir:'/usr/lib/asterisk/modules',astvarlibdir:pbx+'/lib',astdbdir:pbx+'/lib',astkeydir:pbx+'/lib',astdatadir:pbx+'/lib',astagidir:'/lab/telephony/softphone',astspooldir:pbx+'/spool',astrundir:pbx+'/run',astlogdir:pbx+'/logs'};
 const modules=['res_timing_timerfd','res_sorcery_config','res_sorcery_memory','res_sorcery_astdb','res_pjproject','res_pjsip','res_pjsip_session','res_pjsip_pubsub','res_pjsip_authenticator_digest','res_pjsip_outbound_authenticator_digest','res_pjsip_endpoint_identifier_user','res_pjsip_sdp_rtp','res_pjsip_refer','res_pjsip_registrar','res_pjsip_acl','res_rtp_asterisk','res_audiosocket','chan_pjsip','pbx_config','codec_alaw','codec_ulaw','codec_resample','app_audiosocket','app_playback','app_stack','app_echo','res_agi','func_timeout','func_channel','func_logic','res_clioriginate'];
 if(publicConfig)modules.push('res_srtp','res_pjsip_nat');
 const pjsip=pjsipConfig({privateIp:publicIp,clientIp,publicConfig,accounts:credentials.accounts});
 const files={
  'asterisk.conf':'[directories]\n'+Object.entries(paths).map(([k,v])=>k+' => '+v).join('\n')+'\n[options]\nverbose=1\ndebug=0\n',
  'modules.conf':'[modules]\nautoload=no\n'+modules.flatMap(m=>m==='res_agi'?['res_speech',m]:[m]).map(m=>'load='+m+'.so').join('\n')+'\n',
  'manager.conf':'[general]\nenabled=yes\nwebenabled=no\nport=5038\nbindaddr=127.0.0.1\n[test-controller]\nsecret='+credentials.ami+'\ndeny=0.0.0.0/0\npermit=127.0.0.1/32\nread=system,call\nwrite=call,originate\n',
  'logger.conf':'[logfiles]\nconsole=notice,warning,error\n',
  'rtp.conf':'[general]\nrtpstart=18160\nrtpend=18180\nice_support=no\n',
  'pjsip.conf':pjsip,
  'extensions.conf':(await fs.readFile('/lab/telephony/extensions.conf.example','utf8'))+'\n[softphone-test]\nexten => 7000,1,Answer()\n same => n,AGI(incoming.cjs,inbound)\n same => n,GotoIf($["${FOLLOWUP_ID}" = ""]?done)\n same => n,Set(TIMEOUT(absolute)=480)\n same => n,AudioSocket(${FOLLOWUP_ID},127.0.0.1:9092)\n same => n(done),Hangup()\nexten => 7001,1,Answer()\n same => n,AGI(incoming.cjs,callback)\n same => n,Hangup()\nexten => 6999,1,Answer()\n same => n,Set(TIMEOUT(absolute)=30)\n same => n,Echo()\n same => n,Hangup()\n'
 };
 for(const name of ['stasis','ccss','cdr','cel','features','indications','acl','udptl','pjproject'])files[name+'.conf']='[general]\n';
 for(const [name,data]of Object.entries(files))await fs.writeFile(path.join(pbx,'etc',name),data,{mode:0o600});return credentials;
}
async function main(){
 const credentials=await configFiles();
 asterisk=spawn('asterisk',['-f','-g','-C',pbx+'/etc/asterisk.conf'],{stdio:['ignore','inherit','inherit']});
 asterisk.on('exit',()=>{if(!stopping){console.error('PBX stopped');void shutdown(1);}});
 const config={enabled:true,host:'127.0.0.1',port:5038,username:'test-controller',secret:credentials.ami,trunk:'unused',prefix:'',callerId:'7000',mediaHost:'127.0.0.1',mediaPort:9092,mediaTarget:'127.0.0.1:9092',peers:['127.0.0.1'],allowlist:[...allowed],center:'产后随访测试',ringMs:30000,maxMs:480000,maxConcurrent:1,startHour:0,endHour:24,vadThreshold:600,silenceMs:600};
 tel=new Telephone({config,store,agent,speech:Speech});
 const warm=tel.prepareAudio.bind(tel);tel.prepareAudio=async()=>{await warm();if(tel.audioReady){tel.audioReady=false;try{tel.opening=await Speech.speakPcm(opening);tel.audioReady=true;}catch{tel.audioReady=false;}}};
 await tel.start();
 if(publicConfig)tlsFront=await require('./tls-front.cjs').start(publicConfig);
 server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');res.setHeader('Content-Type','application/json');
  try{
   if(req.method==='GET'&&u.pathname==='/status')return res.end(JSON.stringify({ready:tel.status().automaticDial,active:tel.active.size,testOnly:true,publicPhone:publicConfig?{host:publicConfig.host,port:publicConfig.port,transport:'TLS',media:'SRTP'}:null}));
   if(u.pathname.startsWith('/followup-setup/'))return await Provisioning.serve({root,config:publicConfig,credentials,req,res,pathname:u.pathname});
   if(req.method==='POST'&&u.pathname==='/provision'){if(!publicConfig)throw Error('Public phone disabled');return res.end(JSON.stringify(await Provisioning.create(root,publicConfig,u.searchParams.get('extension'))));}
   if(req.method==='GET'&&u.pathname==='/calls')return res.end(JSON.stringify([...rows.values()].slice(-20).map(row=>{const session=tel.active.get(row.id)?.session;return session?{...row,draft:session.snapshot()}:row;})));
   if(req.method==='POST'&&u.pathname==='/stop'){for(const call of tel.active.values())await tel.end(call,'cancelled','test_stopped');return res.end('{"ok":true}');}
   if(req.method==='POST'&&u.pathname==='/dial')return res.end(JSON.stringify({ok:true,id:await dial(u.searchParams.get('extension'))}));
   if(req.method==='POST'&&u.pathname==='/incoming'){
    const channel=u.searchParams.get('channel')||'',extension=channel.match(/^PJSIP\/(600[1-4])-[a-f0-9]+$/)?.[1];
    if(!allowed.has(extension))throw Error('Unknown authenticated endpoint');
    if(u.searchParams.get('mode')==='callback'){if(tel.active.size)throw Error('Call active');setTimeout(()=>void dial(extension).catch(e=>console.error('Callback:',e.message)),3000);return res.end('{"ok":true}');}
    const call=await prepare(extension,'inbound',channel);return res.end(JSON.stringify({ok:true,id:call.row.id}));
   }
   res.statusCode=404;res.end('{"error":"Not found"}');
  }catch(e){res.statusCode=409;res.end(JSON.stringify({ok:false,error:e.message}));}
 });
 await new Promise(resolve=>server.listen(9095,'127.0.0.1',resolve));
 console.log(JSON.stringify({service:'softphone-test',privateIp:publicIp,sipPort:5096,extensions:[...allowed],robot:7000,callback:7001,echo:6999}));
}
async function shutdown(code=0){if(stopping)return;stopping=true;await tel?.stop();tlsFront?.close();server?.close();asterisk?.kill('SIGTERM');await persistence;process.exit(code);}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
main().catch(e=>{console.error(e.message);void shutdown(1);});
