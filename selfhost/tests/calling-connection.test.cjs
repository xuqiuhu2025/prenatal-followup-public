'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const speech=require('../server/speech'),C=require('../server/calling');
const uuid=()=>crypto.randomUUID();
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const actor=()=>{const recordedBy=uuid();return (action,data={})=>C.main({action,recordedBy,...data});};

test('concurrent/lost startup responses share one session and synthesis, even at capacity',async()=>{
 const original=speech.speak,call=actor(),other=actor(),gate=deferred(),ids=[];let count=0;
 try{
  speech.speak=async()=>{count++;return gate.promise;};
  const payload={stage:'outcome',count:2,engine:'scripted',requestId:uuid()};
  const first=call('calling_start',payload),retry=call('calling_start',payload);
  assert.equal(count,1,'a pending start is shared');
  gate.resolve('dGVzdA==');const s=await first;ids.push(s.id);assert.equal(s.ok,true);assert.deepEqual(await retry,s);
  assert.deepEqual(await call('calling_start',payload),s);assert.equal(count,1);
  assert.equal((await call('calling_start',{...payload,count:1})).ok,false);
  const separate=await other('calling_start',payload);assert.equal(separate.ok,true);assert.notEqual(separate.id,s.id);await other('calling_end',{id:separate.id});
  for(let i=0;i<2;i++){const r=await call('calling_start',{...payload,requestId:uuid()});assert.equal(r.ok,true);ids.push(r.id);}
  assert.equal((await call('calling_start',{...payload,requestId:uuid()})).ok,false);
  assert.deepEqual(await call('calling_start',payload),s,'recovery precedes session limit');assert.equal(count,4);
  const turn=await call('calling_turn',{id:s.id,revision:0,requestId:uuid(),answer:'我是本人'});
  assert.equal(turn.ok,true);assert.deepEqual(await call('calling_start',payload),turn,'late startup retry preserves dialogue progress');
 }finally{gate.resolve('dGVzdA==');for(const id of ids)await call('calling_end',{id});speech.speak=original;}
});

test('closing by startup request ID cancels pending and delayed arrivals, with account isolation',async()=>{
 const original=speech.speak,call=actor(),other=actor(),gate=deferred(),requestId=uuid();
 try{
  speech.speak=()=>gate.promise;const pending=call('calling_start',{stage:'custom',requestId});
  assert.equal((await other('calling_end',{requestId})).ok,true);
  assert.equal((await call('calling_end',{requestId})).ok,true);
  gate.resolve('dGVzdA==');assert.equal((await pending).ok,false);
  assert.equal((await call('calling_start',{stage:'custom',requestId})).ok,false);
  const early=uuid();await call('calling_end',{requestId:early});assert.equal((await call('calling_start',{stage:'custom',requestId:early})).ok,false);
  const next=await call('calling_start',{stage:'custom',requestId:uuid()});assert.equal(next.ok,true);
  assert.equal((await other('calling_end',{id:next.id})).ok,false);await call('calling_end',{id:next.id});
 }finally{gate.resolve('dGVzdA==');speech.speak=original;}
});

test('duplicate in-flight audio turns share ASR, dialogue and TTS; changed payloads are rejected',async()=>{
 const originalSpeak=speech.speak,originalRecognize=speech.recognize,call=actor(),gate=deferred();let recognition=0,synthesis=0,id;
 try{
  speech.speak=async()=>{synthesis++;return 'dGVzdA==';};speech.recognize=async()=>{recognition++;return gate.promise;};
  const s=await call('calling_start',{stage:'custom',requestId:uuid()});id=s.id;
  const payload={id,revision:0,requestId:uuid(),audio:'dGVzdA=='};const first=call('calling_turn',payload),retry=call('calling_turn',payload);
  assert.equal(recognition,1);assert.equal((await call('calling_turn',{...payload,audio:'YWJjZA=='})).ok,false);
  assert.equal((await call('calling_turn',{...payload,requestId:uuid()})).ok,false);
  gate.resolve('我是本人');const r=await first;assert.equal(r.ok,true);assert.deepEqual(await retry,r);
  assert.deepEqual(await call('calling_turn',payload),r);assert.equal(recognition,1);assert.equal(synthesis,2);assert.equal(r.revision,1);assert.equal(r.history.filter(m=>m.role==='user').length,1);
 }finally{gate.resolve('我是本人');if(id)await call('calling_end',{id});speech.speak=originalSpeak;speech.recognize=originalRecognize;}
});

test('a synchronous recognition failure does not leave a permanently pending request',async()=>{
 const originalSpeak=speech.speak,originalRecognize=speech.recognize,call=actor();let id;
 try{
  speech.speak=async()=> 'dGVzdA==';const s=await call('calling_start',{stage:'custom'});id=s.id;
  const payload={id,revision:0,requestId:uuid(),audio:'dGVzdA=='};speech.recognize=()=>{throw Error('temporary recognition failure');};
  assert.equal((await call('calling_turn',payload)).ok,false);speech.recognize=async()=> '我是本人';
  const recovered=await call('calling_turn',payload);assert.equal(recovered.ok,true);assert.equal(recovered.revision,1);
 }finally{if(id)await call('calling_end',{id});speech.speak=originalSpeak;speech.recognize=originalRecognize;}
});

test('closing during a turn prevents the shared response from returning success',async()=>{
 const originalSpeak=speech.speak,originalRecognize=speech.recognize,call=actor(),gate=deferred();let id;
 try{
  speech.speak=async()=> 'dGVzdA==';const s=await call('calling_start',{stage:'custom',requestId:uuid()});id=s.id;
  speech.recognize=()=>gate.promise;const payload={id,revision:0,requestId:uuid(),audio:'dGVzdA=='};
  const first=call('calling_turn',payload),retry=call('calling_turn',payload);await call('calling_end',{id});
  gate.resolve('我是本人');assert.equal((await first).ok,false);assert.equal((await retry).ok,false);
 }finally{gate.resolve('我是本人');if(id)await call('calling_end',{id});speech.speak=originalSpeak;speech.recognize=originalRecognize;}
});
