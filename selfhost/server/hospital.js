const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const db=require('./db');
const {fields,validateRows,dateValue,today}=require('./patient-validation');
const text=(v,max=1000)=>String(v??'').trim().slice(0,max);
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function uuid(v){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v||''))throw Error('请求标识无效，请重新打开表单');return v;}
function id(v){if(!/^[1-9]\d{0,15}$/.test(String(v)))throw Error('记录编号无效');return String(v);}
const term=v=>'%'+text(v,100).replace(/[\\%_]/g,m=>'\\'+m)+'%';
const pageOf=e=>Math.min(100000,Math.max(1,parseInt(e.page,10)||1));
const patientColumns=fields.map(f=>f.key);
const patientSelect="SELECT p.*,p.birth_date::text,p.discharge_date::text FROM patients p";
const taskSelect="SELECT t.*,t.due_date::text,p.name,p.patient_no,p.phone,p.department,p.discharge_date::text FROM followup_tasks t JOIN patients p ON p.id=t.patient_id";
async function ensureSchema(){const bundled=path.join(__dirname,'hospital-schema.sql');await db.q(fs.readFileSync(fs.existsSync(bundled)?bundled:path.join(__dirname,'../init/04-hospital.sql'),'utf8'));}
async function cached(client, table, requestId, digest){
 const prev=await client.query('SELECT * FROM '+table+' WHERE request_id=$1',[requestId]);
 if(prev.rows.length){if(prev.rows[0].payload_hash!==digest)throw Error('请求内容已改变，请重新打开表单');return prev.rows[0].result;}
}
async function importPatients(e){
 uuid(e.requestId);if(!['skip','update'].includes(e.strategy))throw Error('请选择重复病案号处理方式');
 const checked=validateRows(e.rows),source=text(e.source||'患者表格',120),digest=hash({checked,source,strategy:e.strategy});
 return db.withTransaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(73429312)');
  const old=await cached(c,'patient_imports',e.requestId,digest);if(old)return old;
  const r={ok:true,inserted:0,updated:0,skipped:0,invalid:0,errors:[]};
  for(const row of checked){
   if(row.errors.length){r.invalid++;r.errors.push({row:row.row,errors:row.errors});continue;}
   const params=patientColumns.map(k=>['birth_date','discharge_date'].includes(k)?row.data[k]||null:k==='sex'?row.data[k]||'未知':row.data[k]);params.push(source);
   const added=await c.query('INSERT INTO patients ('+patientColumns.join(',')+',source) VALUES ('+params.map((_,i)=>'$'+(i+1)).join(',')+') ON CONFLICT(patient_no) DO NOTHING RETURNING id',params);
   if(added.rowCount){r.inserted++;continue;}if(e.strategy==='skip'){r.skipped++;continue;}
   const sets=patientColumns.slice(1).map(k=>{
    const n=patientColumns.indexOf(k)+1;
    if(['birth_date','discharge_date'].includes(k))return k+'=COALESCE($'+n+','+k+')';
    // Missing sex also preserves the existing record.
    if(k==='sex'&&!row.data.sex)params[n-1]='';
    return k+'=COALESCE(NULLIF($'+n+",''),"+k+')';
   });
   await c.query('UPDATE patients SET '+sets.join(',')+',source=$12,updated_at=now() WHERE patient_no=$1',params);r.updated++;
  }
  await c.query('INSERT INTO patient_imports(request_id,payload_hash,result) VALUES($1,$2,$3::jsonb)',[e.requestId,digest,JSON.stringify(r)]);return r;
 });
}
async function patients(e){
 const page=pageOf(e),params=[term(e.keyword),text(e.department,80)];
 const where=" WHERE (p.name ILIKE $1 OR p.patient_no ILIKE $1 OR p.phone ILIKE $1 OR p.clinician ILIKE $1) AND ($2='' OR p.department=$2)";
 const [list,count,summary,departments]=await Promise.all([
  db.q(patientSelect+where+' ORDER BY p.updated_at DESC,p.id DESC LIMIT 20 OFFSET $3',[...params,(page-1)*20]),
  db.q('SELECT count(*)::int total FROM patients p'+where,params),
  db.q("SELECT count(*)::int total,count(*) FILTER(WHERE discharge_date IS NOT NULL)::int discharged,count(DISTINCT NULLIF(department,''))::int departments FROM patients"),
  db.q("SELECT DISTINCT department FROM patients WHERE department<>'' ORDER BY department")
 ]);return {ok:true,list,total:count[0].total,page,pageSize:20,summary:summary[0],departments:departments.map(d=>d.department)};
}
async function patient(e){
 const patientId=id(e.id),rows=await db.q(patientSelect+' WHERE p.id=$1',[patientId]);if(!rows.length)throw Error('患者不存在');
 const [tasks,records]=await Promise.all([
  db.q(taskSelect+' WHERE p.id=$1 AND t.prenatal_case_id IS NULL ORDER BY t.due_date DESC,t.id DESC LIMIT 100',[patientId]),
  db.q('SELECT r.*,r.next_date::text,t.title FROM followup_records r JOIN followup_tasks t ON t.id=r.task_id WHERE t.patient_id=$1 AND t.prenatal_case_id IS NULL ORDER BY r.id DESC LIMIT 100',[patientId])
 ]);return {ok:true,patient:rows[0],tasks,records};
}
async function savePatient(e){
 if(!e.id)return importPatients({...e,rows:[e.patient],source:'手工建档',strategy:'skip'});
 const checked=validateRows([e.patient])[0];if(checked.errors.length)throw Error(checked.errors.join('；'));
 const params=patientColumns.map(k=>['birth_date','discharge_date'].includes(k)?checked.data[k]||null:k==='sex'?checked.data[k]||'未知':checked.data[k]);params.push(id(e.id));
 try{const rows=await db.q('UPDATE patients SET '+patientColumns.map((k,i)=>k+'=$'+(i+1)).join(',')+',updated_at=now() WHERE id=$12 RETURNING id',params);if(!rows.length)throw Error('患者不存在');return {ok:true,id:rows[0].id};}
 catch(err){if(err.code==='23505')throw Error('该病案号已存在');throw err;}
}
async function createPlan(e){
 uuid(e.requestId);const patientId=id(e.patientId),title=text(e.title,120),assigned=text(e.assignedTo,80),focus=text(e.focus),channel=e.channel;
 if(!['single','schedule'].includes(e.mode))throw Error('计划方式无效');
 if(!title||!assigned)throw Error('请填写随访名称和责任医护');if(!['phone','clinic','online'].includes(channel))throw Error('随访方式无效');
 return db.withTransaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(73429313)');
  const digest=hash({patientId,title,assigned,focus,channel,mode:e.mode,dueDate:e.mode==='single'?e.dueDate:null,offsets:e.mode==='schedule'?e.offsets:null});
  const old=await cached(c,'followup_plans',e.requestId,digest);if(old)return old;
  const rows=await c.query('SELECT *,discharge_date::text FROM patients WHERE id=$1 FOR SHARE',[patientId]);if(!rows.rows.length)throw Error('患者不存在');
  const p=rows.rows[0];let dates;
  if(e.mode==='schedule'){
   const offsets=Array.isArray(e.offsets)?[...new Set(e.offsets)]:[];
   if(!p.discharge_date)throw Error('请先填写患者出院日期');
   if(!offsets.length||offsets.length>12||offsets.some(n=>!Number.isInteger(n)||n<0||n>365))throw Error('随访节点须为 0–365 天，最多 12 个');
   dates=offsets.sort((a,b)=>a-b).map(n=>new Date(Date.parse(p.discharge_date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10));
  }else{const d=dateValue(e.dueDate);if(!d||d<'2000-01-01'||d>'2100-12-31')throw Error('请选择有效随访日期');dates=[d];}
  const ids=[];for(const d of dates){const r=await c.query('INSERT INTO followup_tasks(patient_id,title,due_date,assigned_to,channel,focus,plan_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[patientId,title,d,assigned,channel,focus,e.requestId]);ids.push(r.rows[0].id);}
  const result={ok:true,created:ids.length,ids};await c.query('INSERT INTO followup_plans(request_id,payload_hash,result) VALUES($1,$2,$3::jsonb)',[e.requestId,digest,JSON.stringify(result)]);return result;
 });
}
async function tasks(e){
 const page=pageOf(e),filter=e.status||'pending',params=[term(e.keyword),text(e.department,80)];
 const filters={all:'TRUE',pending:"t.status='pending'",today:"t.status='pending' AND t.due_date=(now() AT TIME ZONE 'Asia/Shanghai')::date",overdue:"t.status='pending' AND t.due_date<(now() AT TIME ZONE 'Asia/Shanghai')::date",completed:"t.status='completed'",cancelled:"t.status='cancelled'"};
 if(!filters[filter])throw Error('任务筛选无效');
 const where=" WHERE t.prenatal_case_id IS NULL AND (p.name ILIKE $1 OR p.patient_no ILIKE $1 OR t.assigned_to ILIKE $1) AND ($2='' OR p.department=$2) AND "+filters[filter];
 const [list,count]=await Promise.all([db.q(taskSelect+where+' ORDER BY t.due_date,t.id LIMIT 20 OFFSET $3',[...params,(page-1)*20]),db.q('SELECT count(*)::int total FROM followup_tasks t JOIN patients p ON p.id=t.patient_id'+where,params)]);
 return {ok:true,list,total:count[0].total,page,pageSize:20};
}
async function record(e){
 uuid(e.requestId);const taskId=id(e.taskId),operator=text(e.operator,80),notes=text(e.notes,2000),contact=e.contact,condition=e.condition||'unknown',medication=e.medication||'unknown',appointment=e.appointment||'unknown';
 if(!operator||!notes)throw Error('请填写记录人和随访记录');
 if(!['reached','unreachable','declined','cancelled'].includes(contact)||!['stable','attention','urgent','unknown'].includes(condition)||!['as_directed','issue','not_applicable','unknown'].includes(medication)||!['scheduled','needed','not_needed','unknown'].includes(appointment))throw Error('随访选项无效');
 if(contact!=='reached'&&[condition,medication,appointment].some(v=>v!=='unknown'))throw Error('未联系成功时，健康反馈应设为未评估');
 const next=e.nextDate?dateValue(e.nextDate):null;if(e.nextDate&&(!next||next<today()||next>'2100-12-31'))throw Error('再次随访日期不能早于今天');
 if(contact==='unreachable'&&!next)throw Error('未接通时请安排再次联系日期');
 if(['cancelled','declined'].includes(contact)&&next)throw Error('取消任务或拒绝随访时无需安排再次随访');
 const digest=hash({taskId,operator,notes,contact,condition,medication,appointment,next});
 return db.withTransaction(async c=>{
  const found=await c.query('SELECT * FROM followup_tasks WHERE id=$1 FOR UPDATE',[taskId]);if(!found.rows.length)throw Error('随访任务不存在');
  const old=await c.query('SELECT payload_hash FROM followup_records WHERE request_id=$1',[e.requestId]);if(old.rows.length){if(old.rows[0].payload_hash!==digest)throw Error('请求内容已改变');return {ok:true};}
  const task=found.rows[0];if(task.prenatal_case_id)throw Error('请在产前随访任务中登记结构化结果');if(task.status!=='pending')throw Error('该任务已处理，请刷新列表');
  await c.query('INSERT INTO followup_records(task_id,request_id,payload_hash,operator,contact,condition,medication,appointment,notes,next_date,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[taskId,e.requestId,digest,operator,contact,condition,medication,appointment,notes,next,e.recordedBy||null]);
  if(contact==='unreachable')await c.query('UPDATE followup_tasks SET due_date=$2 WHERE id=$1',[taskId,next]);
  else{
   await c.query('UPDATE followup_tasks SET status=$2,completed_at=now() WHERE id=$1',[taskId,contact==='cancelled'?'cancelled':'completed']);
   if(next)await c.query('INSERT INTO followup_tasks(patient_id,title,due_date,assigned_to,channel,focus,plan_key) VALUES($1,$2,$3,$4,$5,$6,$7)',[task.patient_id,task.title.slice(0,114)+'（再次随访）',next,operator,task.channel,task.focus,e.requestId]);
  }
  return {ok:true};
 });
}
async function records(e){const page=pageOf(e);const where=" WHERE t.prenatal_case_id IS NULL AND (p.name ILIKE $1 OR p.patient_no ILIKE $1 OR r.operator ILIKE $1) AND ($2='' OR r.condition=$2)";const params=[term(e.keyword),['attention','urgent'].includes(e.condition)?e.condition:''];const [list,count]=await Promise.all([db.q('SELECT r.*,r.next_date::text,p.name,p.patient_no,p.department,t.title FROM followup_records r JOIN followup_tasks t ON t.id=r.task_id JOIN patients p ON p.id=t.patient_id'+where+' ORDER BY r.id DESC LIMIT 20 OFFSET $3',[...params,(page-1)*20]),db.q('SELECT count(*)::int total FROM followup_records r JOIN followup_tasks t ON t.id=r.task_id JOIN patients p ON p.id=t.patient_id'+where,params)]);return {ok:true,list,total:count[0].total,page,pageSize:20};}
async function overview(){
 const [patientsCount,totals,due,departments,recent]=await Promise.all([
 db.q('SELECT count(*)::int total FROM patients'),
 db.q("SELECT count(*) FILTER(WHERE status='pending')::int pending,count(*) FILTER(WHERE status='pending' AND due_date=(now() AT TIME ZONE 'Asia/Shanghai')::date)::int today,count(*) FILTER(WHERE status='pending' AND due_date<(now() AT TIME ZONE 'Asia/Shanghai')::date)::int overdue,count(*) FILTER(WHERE status='completed')::int completed FROM followup_tasks WHERE prenatal_case_id IS NULL"),
 db.q(taskSelect+" WHERE t.prenatal_case_id IS NULL AND t.status='pending' ORDER BY t.due_date,t.id LIMIT 6"),
 db.q("SELECT COALESCE(NULLIF(p.department,''),'未分配科室') department,count(*)::int total FROM followup_tasks t JOIN patients p ON p.id=t.patient_id WHERE t.prenatal_case_id IS NULL AND t.status='pending' GROUP BY p.department ORDER BY total DESC LIMIT 8"),
 db.q('SELECT r.*,p.name,t.title FROM followup_records r JOIN followup_tasks t ON t.id=r.task_id JOIN patients p ON p.id=t.patient_id WHERE t.prenatal_case_id IS NULL ORDER BY r.id DESC LIMIT 5')]);
 return {ok:true,totals:{patients:patientsCount[0].total,...totals[0]},due,departments,recent};
}
const handlers={hospital_overview:overview,patient_list:patients,patient_detail:patient,patient_save:savePatient,patient_import:importPatients,followup_create:createPlan,followup_list:tasks,followup_record:record,followup_records:records};
async function main(e){const fn=handlers[e.action];if(!fn)return {ok:false,error:'医院模式不支持此操作'};try{return await fn(e);}catch(err){if(err.code){console.error('hospital database error',err.code);return {ok:false,error:err.code==='23505'?'记录已存在，请刷新后重试':'数据保存失败，请重试'};}return {ok:false,error:err.message||'处理失败'};}}
module.exports={ensureSchema,main};
