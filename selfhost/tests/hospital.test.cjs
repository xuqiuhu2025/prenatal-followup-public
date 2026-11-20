const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateRows,dateValue,guessMapping}=require('../server/patient-validation');
const PatientData=require('../server/patient-validation');
const Module=require('node:module');
const fakeDb={q:null};
const load=Module._load;
Module._load=function(request,parent,isMain){
 if(request==='./db'&&parent&&parent.filename.endsWith('hospital-chat.js'))return fakeDb;
 return load.call(this,request,parent,isMain);
};
const hospitalChat=require('../server/hospital-chat');
Module._load=load;
const base={patient_no:'p-001',name:'测试患者',phone:'+86 138-0013-8000'};
test('DEMO patient identifiers are visibly blocked from one-tap dialing while real records keep their tel link',()=>{
 const escaped=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
 assert.equal(PatientData.isDemoRecord({patient_no:'DEMO-PN-001'}),true);
 assert.equal(PatientData.isDemoRecord({patient_no:'PN-001'}),false);
 const demo=PatientData.dialLink('13900000001','一键拨号',{patient_no:'DEMO-PN-001'},escaped);
 assert.match(demo,/演示数据 · 禁止拨号/);assert.doesNotMatch(demo,/tel:/);
 const real=PatientData.dialLink('13800138000','一键拨号',{patient_no:'PN-001'},escaped);
 assert.match(real,/href="tel:\+8613800138000"/);
});
test('patient number normalization and shared family phone',()=>{
 const rows=validateRows([base,{...base,patient_no:'P-002'},{...base,patient_no:'P-001'}]);
 assert.equal(rows[0].data.patient_no,'P-001');assert.equal(rows[0].data.phone,'13800138000');assert.deepEqual(rows[0].errors,[]);assert.deepEqual(rows[1].errors,[]);assert.match(rows[2].errors.join(),/重复/);
});
test('invalid rows do not reserve identifiers; malformed dates and future dates rejected',()=>{
 const rows=validateRows([{...base,name:''},base]);assert.equal(rows[1].errors.length,0);
 assert.equal(dateValue('2024/2/29'),'2024-02-29');assert.equal(dateValue('2025-02-29'),null);assert.equal(dateValue('2024-13-01'),null);assert.equal(dateValue(45292),'2024-01-01');
 assert.match(validateRows([{...base,discharge_date:'2099-01-01'}])[0].errors.join(),/今天/);
 assert.match(validateRows([{...base,birth_date:'2000-01-01',discharge_date:'1999-01-01'}])[0].errors.join(),/早于/);
 assert.equal(guessMapping(['病案号','姓名','联系电话','出院日期']).discharge_date,3);
});
test('missing required identity and import limits',()=>{
 assert.match(validateRows([{name:'患者',phone:'13800138000'}])[0].errors.join(),/病案号/);
 assert.throws(()=>validateRows([]));assert.throws(()=>validateRows(Array(2001).fill(base)));
 assert.match(validateRows([{...base,notes:'x'.repeat(1001)}])[0].errors.join(),/1000/);
});
test('only the latest exact assistant reply is marked as interrupted for voice context',async()=>{
 const original=fakeDb.q,calls=[];fakeDb.q=async(sql,params)=>{calls.push({sql,params});return [{id:'42'}];};
 try{
  assert.equal(await hospitalChat.markInterruptedReply('h_session','这是一句被打断的回复'),true);
  assert.match(calls[0].sql,/ORDER BY id DESC LIMIT 1/);
  assert.deepEqual(calls[0].params,['h_session','这是一句被打断的回复','（语音播报被插话打断，患者未完整听到）']);
  assert.equal(await hospitalChat.markInterruptedReply('h_session',''),false);
  assert.equal(calls.length,1);
 }finally{fakeDb.q=original;}
});
