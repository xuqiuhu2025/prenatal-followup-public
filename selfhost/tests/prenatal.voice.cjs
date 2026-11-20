const assert=require('node:assert/strict'),crypto=require('node:crypto');
(async()=>{
 assert.match(process.env.DATABASE_URL||'',/\/cs_prenatal_qa_20261111$/);
 const endpoint=(process.env.TTS_URL||'http://host.docker.internal:28852').replace(/\/+$/,'');
 const audio=await fetch(endpoint+'/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'产前筛查高风险是什么意思？'}),signal:AbortSignal.timeout(60000)});assert.equal(audio.ok,true);
 const r=await require('../server/voice').main({sessionId:'h_'+crypto.randomUUID(),audio:Buffer.from(await audio.arrayBuffer()).toString('base64')});assert.equal(r.ok,true,r.error);assert.match(r.reply,/高风险不等于确诊/);assert.ok(r.audio&&r.audio.length>1000);
 console.log('PASS prenatal voice: synthetic question → speech recognition → prenatal guidance → speech synthesis; clinical data untouched.');
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1);});
