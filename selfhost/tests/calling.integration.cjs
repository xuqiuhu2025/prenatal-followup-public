const assert=require('node:assert/strict'),crypto=require('node:crypto'),db=require('../server/db'),speech=require('../server/speech'),admin=require('../server/admin');
let token;async function call(action,data={}){return admin.main({action,token,...data},{ip:'calling-qa'});}async function ok(action,data={}){const r=await call(action,data);assert.equal(r.ok,true,JSON.stringify(r));return r;}
(async()=>{
 assert.match(process.env.DATABASE_URL||'',/\/cs_calling_qa_20261111$/);
 await require('../server/hospital').ensureSchema();await require('../server/accounts').ensureSchema();await require('../server/prenatal').ensureSchema();
 assert.equal((await call('calling_status')).unauthorized,true);const a=await ok('login',{username:'admin',password:require('./require-test-password.cjs')()});token=a.token;
 await ok('patient_save',{requestId:crypto.randomUUID(),patient:{patient_no:'CALL-QA',name:'仅测试档案',phone:'13800138000'}});const p=(await ok('patient_list')).list[0];
 const c=await ok('prenatal_save',{patientId:p.id,case:{pregnancy_no:'2026-CALL',fetus_count:2,projects:['serum']}});await ok('prenatal_plan',{caseId:c.id,requestId:crypto.randomUUID(),project:'serum',assignedTo:'医护',channel:'phone',nodes:[{stage:'outcome',date:'2026-11-11'}]});
 assert.equal((await ok('calling_status')).automaticDial,false);assert.equal((await call('calling_dial',{taskId:'1'})).code,'LINE_NOT_CONNECTED');
 const before=await db.q('SELECT id,status,completed_at FROM followup_tasks ORDER BY id'),records=await db.q('SELECT id FROM followup_records');
 const s=await ok('calling_start',{stage:'notification',count:1});assert.ok(s.audio&&s.audio.length>1000,'real TTS');
 // Synthetic recording exercises FFmpeg, ASR, dialogue advancement and TTS without a phone call.
 const utterance=await speech.speak('我是本人。');const one=await ok('calling_turn',{id:s.id,revision:0,requestId:crypto.randomUUID(),audio:utterance});assert.equal(one.revision,1);assert.match(one.reply,/方便继续/);assert.ok(one.audio);
 const two=await ok('calling_turn',{id:s.id,revision:1,requestId:crypto.randomUUID(),answer:'同意'});assert.match(two.reply,/收到/);
 const end=await ok('calling_turn',{id:s.id,revision:2,requestId:crypto.randomUUID(),answer:'结束'});assert.equal(end.done,true);assert.equal(end.outcome,'declined');await ok('calling_end',{id:s.id});
 const staff=await ok('account_save',{username:'call_nurse',displayName:'语音测试医护',role:'staff',department:'产前中心',password:'Call-QA-2026'});const nurse=await ok('login',{username:'call_nurse',password:'Call-QA-2026'});
 assert.equal((await call('calling_status',{token:nurse.token})).ok,true);await ok('account_status',{id:staff.user.id,enabled:false});assert.equal((await call('calling_start',{token:nurse.token,stage:'outcome'})).unauthorized,true);
 assert.deepEqual(await db.q('SELECT id,status,completed_at FROM followup_tasks ORDER BY id'),before);assert.deepEqual(await db.q('SELECT id FROM followup_records'),records);
 console.log('PASS calling integration: authenticated access, disabled-account denial, real ASR/TTS rehearsal round, no outgoing phone call, no clinical record/task mutation.');
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1);});
