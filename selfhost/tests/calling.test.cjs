const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const D=require('../server/followup-dialogue'),speech=require('../server/speech');
test('verify identity and consent before collecting answers; refuse and ambiguous answers stop',()=>{
 let s=D.create('outcome',2);assert.equal(s.answers.length,0);D.advance(s,'不是本人，没有授权');assert.equal(s.outcome,'declined');assert.equal(s.answers.length,0);
 s=D.create('notification');D.advance(s,'天气很好');assert.equal(s.phase,'identity');D.advance(s,'天气很好');assert.equal(s.outcome,'needs_review');
 s=D.create('notification');D.advance(s,'我是本人');assert.equal(s.phase,'consent');D.advance(s,'不方便');assert.equal(s.outcome,'declined');
});
test('stage coverage, per-fetus questions, verbatim unknown answers and no fabricated clinical outcome',()=>{
 for(const stage of ['notification','referral','procedure','report','outcome','postnatal','custom']){const s=D.create(stage,2);D.advance(s,'我是本人');D.advance(s,'同意');let turns=0;while(!s.done&&turns++<s.questions.length)D.advance(s,'不清楚');assert.equal(s.done,true);assert.equal(s.outcome,stage==='postnatal'?'needs_review':'collected');assert.ok(s.answers.every(a=>a.answer==='不清楚'&&a.unverified));assert.ok(s.answers.length<=s.questions.length);assert.ok(D.snapshot(s).progress<=D.snapshot(s).total);if(stage==='postnatal'){assert.ok(D.snapshot(s).deferred.some(x=>x.key==='f1_birth'));assert.deepEqual(D.postnatalCare(s).birthStatus,{});}}
 assert.ok(D.questions('outcome',2).some(q=>q.key==='f2_outcome'));assert.ok(D.questions('postnatal',3).some(q=>q.key==='f3_birth'));
 const post=D.questions('postnatal',2);for(const field of ['birth','perinatal','neonatal_course','health','confirmation','nonliveborn_review'])assert.ok(post.some(q=>q.key==='f2_'+field),field);
 assert.match(post.find(q=>q.key==='f1_perinatal').instructions,/身长/);assert.match(post.find(q=>q.key==='f1_perinatal').instructions,/Apgar/);assert.match(post.find(q=>q.key==='f1_neonatal_course').instructions,/听力.*遗传代谢筛查/);assert.doesNotMatch(post.find(q=>q.key==='f1_perinatal').prompt,/Apgar|评分时点/);
 assert.equal(D.urgent('病历记录孕32+0周胎动减少，超声报告提示无胎心，之后按医嘱处理'),false);assert.equal(D.urgent('目前没有不适。病历记载妊娠于2026年10月1日结束；超声记录为未见胎心，原因不明'),false);assert.equal(D.urgent('目前超声检查仍未见胎心'),true);assert.equal(D.urgent('以前胎动减少，目前已处理，现在没有不适'),false);assert.equal(D.urgent('孕32周胎动减少，目前仍明显减少'),true);assert.equal(D.urgent('目前呼吸困难，喘不过气'),true);
 assert.throws(()=>D.create('invalid'));assert.throws(()=>D.create('outcome',7));
});
test('diagnostic requests do not answer questionnaire; acute symptom branches and negative description',()=>{
 let s=D.create('notification');D.advance(s,'是');D.advance(s,'同意');D.advance(s,'是不是确诊？');assert.equal(s.index,0);assert.match(s.history.at(-1).text,/不等于确诊/);D.advance(s,'怎么办？');assert.equal(s.outcome,'needs_review');
 s=D.create('procedure');D.advance(s,'是');D.advance(s,'同意');D.advance(s,'没有大量出血');assert.equal(s.done,false);D.advance(s,'没有大量出血，但是现在呼吸困难');assert.equal(s.outcome,'urgent');assert.match(s.history.at(-1).text,/120/);
 s=D.create('notification');D.advance(s,'是');D.advance(s,'同意');D.advance(s,'我不想回答');assert.equal(s.outcome,'declined');
 s=D.create('referral');D.advance(s,'是');D.advance(s,'同意');D.advance(s,'我拒绝诊断');assert.equal(s.done,false);assert.equal(s.answers[0].answer,'我拒绝诊断');
});
test('authenticated rehearsal service: ownership, idempotency, stale revision, processing conflict, cleanup and unavailable phone line',async()=>{
 const originalSpeak=speech.speak,originalRecognize=speech.recognize;let synthesisCount=0;try{
  speech.speak=async()=>{synthesisCount++;return 'dGVzdA==';};speech.recognize=async()=> '我是本人';
  const C=require('../server/calling'),actor={recordedBy:'7'},call=(action,e={})=>C.main({action,...actor,...e});
  assert.equal((await C.main({action:'calling_status'})).ok,false);assert.equal((await call('calling_status')).automaticDial,false);assert.equal((await call('calling_dial')).code,'LINE_NOT_CONNECTED');
  const s=await call('calling_start',{stage:'notification'});assert.equal(s.mode,'rehearsal');assert.equal(s.progress,0);
  assert.equal((await call('calling_turn',{id:s.id,recordedBy:'8',revision:0,requestId:crypto.randomUUID(),answer:'是'})).ok,false);
  const payload={id:s.id,revision:0,requestId:crypto.randomUUID(),answer:'我是本人'};const r=await call('calling_turn',payload);assert.equal(r.revision,1);assert.deepEqual(await call('calling_turn',payload),r);assert.equal(synthesisCount,2);
  assert.equal((await call('calling_turn',{...payload,answer:'不是本人'})).ok,false);assert.equal((await call('calling_turn',{...payload,requestId:crypto.randomUUID()})).ok,false);
  let unblock;speech.recognize=()=>new Promise(resolve=>unblock=resolve);const pending=call('calling_turn',{id:s.id,revision:1,requestId:crypto.randomUUID(),audio:'dGVzdA=='});assert.equal((await call('calling_turn',{id:s.id,revision:1,requestId:crypto.randomUUID(),answer:'同意'})).ok,false);unblock('同意');assert.equal((await pending).ok,true);
  speech.speak=async()=>{throw Error('network');};const fallback=await call('calling_turn',{id:s.id,revision:2,requestId:crypto.randomUUID(),answer:'已收到报告'});assert.equal(fallback.ok,true);assert.ok(fallback.audioError);assert.equal(fallback.audio,null);
  await call('calling_end',{id:s.id});assert.equal((await call('calling_turn',{...payload,revision:3})).ok,false);
 }finally{speech.speak=originalSpeak;speech.recognize=originalRecognize;}
});
test('invalid or oversized audio is rejected before conversion',async()=>{
 await assert.rejects(speech.recognize('../not-base64'),/格式/);await assert.rejects(speech.recognize('a'.repeat(4*1024*1024+4)),/超过/);
});

function readyPost(count=1,identity='我是本人'){const s=D.create('postnatal',count);D.advance(s,identity);D.advance(s,'同意');return s;}
test('conversation branches use explicit current facts and keep twins independent',()=>{
 for(const text of ['孩子没有发生自然流产','不是孩子没保住','如果孩子没保住，那怎么办','我担心宝宝没保住','上一胎，孩子没保住','孩子还没出生','宝宝不是活产','宝宝没有出生']){const s=readyPost();assert.equal(D.observePostnatal(s,text),null,text);assert.deepEqual(s.care.birthStatus,{},text);}
 let s=readyPost();assert.equal(D.observePostnatal(s,'上一胎没保住。这次宝宝现在两个月，吃奶睡觉都好'),null);assert.equal(s.care.birthStatus[1],'liveborn');
 s=readyPost();assert.equal(D.observePostnatal(s,'孩子没保住，我不想回顾经过'),1);assert.equal(s.care.birthStatus[1],'loss_reported');assert.ok(!D.activeQuestions(s).some(q=>q.key==='f1_health'));
 s=readyPost(2);assert.equal(D.observePostnatal(s,'第一胎出生后3天出院，第二胎没保住'),2);assert.equal(s.care.birthStatus[1],'liveborn');assert.equal(s.care.birthStatus[2],'loss_reported');assert.ok(D.activeQuestions(s).some(q=>q.key==='f1_health'));assert.ok(!D.activeQuestions(s).some(q=>q.key==='f2_health'));
 const text='大宝出生后3天出院，小宝没保住';assert.equal(D.matchesFetus(s,'f1_birth','出生后3天出院',text),true);assert.equal(D.matchesFetus(s,'f2_birth','出生后3天出院',text),false);assert.equal(D.matchesFetus(s,'f1_birth',text,text),false);
 s=readyPost(2);D.observePostnatal(s,'大宝出生后3天出院，小宝没保住');assert.equal(s.care.birthStatus[1],'liveborn');assert.equal(s.care.birthStatus[2],'loss_reported');
});
test('scripted loss response asks permission, respects detail refusal, and never records consent as clinical evidence',()=>{
 const s=readyPost();let r=D.advance(s,'孩子没保住');assert.match(r.reply,/很遗憾.*愿意继续/);const before=s.answers.length;D.advance(s,'可以');assert.equal(s.answers.length,before);assert.equal(s.currentKey,'maternal_recovery');
 D.advance(s,'身体恢复还好');r=D.advance(s,'不想回顾这部分');assert.match(r.reply,/先不聊这部分/);assert.doesNotMatch(r.reply,/哪天|经过|评分/);assert.ok(D.snapshot(s).deferred.some(x=>x.key==='f1_nonliveborn_review'));assert.equal(s.answers.filter(a=>a.answer==='可以').length,0);
 assert.ok(D.snapshot(s).progress<=D.snapshot(s).total);D.advance(s,'今天不想继续聊了');assert.equal(s.outcome,'declined');
});
test('scripted unknown and family answers preserve a visible review trail without repeated questions',()=>{
 const s=readyPost(1,'我是家属');assert.match(s.history.at(-1).text,/妈妈/);D.advance(s,'我自己的身体挺好');assert.equal(s.answers.length,0);assert.match(s.history.at(-1).text,/妈妈/);D.advance(s,'她恢复还可以');
 let r=D.advance(s,'不清楚');assert.ok(D.snapshot(s).deferred.some(x=>x.key==='f1_health'&&x.evidence==='不清楚'));assert.doesNotMatch(r.reply,/生产|住院|吃奶|评分/);
 let turns=0;while(!s.done&&turns++<20)D.advance(s,'不清楚');assert.equal(s.outcome,'needs_review');assert.ok(s.answers.every(x=>x.unverified));
 assert.equal(D.endsConversation('我不是不想继续'),false);assert.equal(D.endsConversation('今天不想继续聊了'),true);assert.equal(D.skipsDetailsOnly('我不想说这些细节'),true);assert.equal(D.skipsDetailsOnly('我不想聊了'),false);
});
