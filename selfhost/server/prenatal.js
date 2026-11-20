const fs=require('fs'),path=require('path'),crypto=require('crypto'),db=require('./db'),D=require('./prenatal-data');
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const id=v=>{if(!/^[1-9]\d{0,15}$/.test(String(v)))throw Error('记录编号无效');return String(v);};
const uuid=v=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v||''))throw Error('请求标识无效');return v;};
const text=(v,max=1000)=>{if(v==null)return '';if(typeof v!=='string'||v.length>max)throw Error('文本格式或长度无效');return v.trim();};
const like=v=>'%'+String(v||'').slice(0,100).split('').map(c=>['%','_',String.fromCharCode(92)].includes(c)?String.fromCharCode(92)+c:c).join('')+'%';
const page=e=>Math.min(100000,Math.max(1,parseInt(e.page,10)||1));
const caseSelect='SELECT c.*,c.lmp::text,c.edd::text,p.name,p.patient_no,p.phone,p.department,p.clinician FROM prenatal_cases c JOIN patients p ON p.id=c.patient_id';
const taskSelect='SELECT t.*,t.due_date::text,c.pregnancy_no,c.fetus_count,c.status case_status,p.name,p.patient_no,p.phone,p.department FROM followup_tasks t JOIN prenatal_cases c ON c.id=t.prenatal_case_id JOIN patients p ON p.id=c.patient_id';
async function ensureSchema(){const f=path.join(__dirname,'prenatal-schema.sql');await db.q(fs.readFileSync(fs.existsSync(f)?f:path.join(__dirname,'../init/06-prenatal.sql'),'utf8'));}
async function change(c,caseId,actor,action,detail){await c.query('INSERT INTO prenatal_changes(case_id,actor_id,action,detail) VALUES($1,$2,$3,$4)',[caseId,actor,action,detail]);}
async function cached(c,table,requestId,hash){const r=await c.query('SELECT * FROM '+table+' WHERE request_id=$1',[requestId]);if(r.rowCount){if(r.rows[0].payload_hash!==hash)throw Error('请求内容已改变，请重新提交');return r.rows[0].result;}}
async function saveCase(e){const v=D.validateCase(e.case||{}),patientId=id(e.patientId);return db.withTransaction(async c=>{
 await c.query('SELECT pg_advisory_xact_lock(73429315)');
 let caseId=e.id?id(e.id):null;
 if(caseId){const old=(await c.query('SELECT * FROM prenatal_cases WHERE id=$1 FOR UPDATE',[caseId])).rows[0];if(!old||String(old.patient_id)!==patientId)throw Error('孕次档案不存在');if(old.status!=='active')throw Error('请先重新开启孕次随访再修改档案');if(String(new Date(old.updated_at).getTime())!==String(e.version))throw Error('档案已被更新，请重新打开');
  if(old.fetus_count!==v.fetus_count&&(await c.query('SELECT r.id FROM followup_records r JOIN followup_tasks t ON t.id=r.task_id WHERE t.prenatal_case_id=$1 AND r.prenatal_data IS NOT NULL LIMIT 1',[caseId])).rowCount)throw Error('已有随访记录，胎数不可直接更改');
  await c.query('UPDATE prenatal_cases SET pregnancy_no=$2,lmp=$3,edd=$4,fetus_count=$5,referral_org=$6,indications=$7,updated_at=now() WHERE id=$1',[caseId,v.pregnancy_no,v.lmp||null,v.edd||null,v.fetus_count,v.referral_org,v.indications]);
 }else{const r=await c.query('INSERT INTO prenatal_cases(patient_id,pregnancy_no,lmp,edd,fetus_count,referral_org,indications) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[patientId,v.pregnancy_no,v.lmp||null,v.edd||null,v.fetus_count,v.referral_org,v.indications]);caseId=r.rows[0].id;}
 for(const code of v.projects)await c.query('INSERT INTO prenatal_projects(case_id,project_code) VALUES($1,$2) ON CONFLICT DO NOTHING',[caseId,code]);
 await change(c,caseId,e.recordedBy,e.id?'case_edit':'case_create',v);return {ok:true,id:caseId};
 });}
async function cases(e){const n=page(e),params=[like(e.keyword),D.options.status.some(x=>x[0]===e.status)?e.status:'',D.getProject(e.project)?e.project:'',e.risk==='high'];const where=" WHERE (p.name ILIKE $1 OR p.patient_no ILIKE $1 OR c.pregnancy_no ILIKE $1 OR p.phone ILIKE $1) AND ($2='' OR c.status=$2) AND ($3='' OR EXISTS(SELECT 1 FROM prenatal_projects j WHERE j.case_id=c.id AND j.project_code=$3)) AND (NOT $4 OR EXISTS(SELECT 1 FROM prenatal_projects j WHERE j.case_id=c.id AND j.result->>'screen_risk' IN ('high','suspected')))";
 const [rows,count]=await Promise.all([db.q(caseSelect+where+' ORDER BY c.updated_at DESC,c.id DESC LIMIT 20 OFFSET $5',[...params,(n-1)*20]),db.q('SELECT count(*)::int total FROM prenatal_cases c JOIN patients p ON p.id=c.patient_id'+where,params)]);
 const projects=rows.length?await db.q('SELECT * FROM prenatal_projects WHERE case_id=ANY($1::bigint[])',[rows.map(r=>r.id)]):[];
 return {ok:true,list:rows.map(r=>({...r,projects:projects.filter(j=>j.case_id===r.id)})),total:count[0].total,page:n};}
async function detail(e){const caseId=id(e.id),rows=await db.q(caseSelect+' WHERE c.id=$1',[caseId]);if(!rows.length)throw Error('孕次档案不存在');const [projects,tasks,records,changes]=await Promise.all([
 db.q('SELECT * FROM prenatal_projects WHERE case_id=$1 ORDER BY id',[caseId]),db.q(taskSelect+' WHERE c.id=$1 ORDER BY t.due_date DESC,t.id DESC LIMIT 100',[caseId]),
 db.q('SELECT r.*,r.next_date::text,t.title,t.project_code,t.stage_code FROM followup_records r JOIN followup_tasks t ON t.id=r.task_id WHERE t.prenatal_case_id=$1 ORDER BY r.id DESC LIMIT 100',[caseId]),
 db.q('SELECT c.*,a.display_name FROM prenatal_changes c JOIN staff_accounts a ON a.id=c.actor_id WHERE c.case_id=$1 ORDER BY c.id DESC LIMIT 30',[caseId])]);return {ok:true,case:rows[0],projects,tasks,records,changes};}
async function saveReport(e){const caseId=id(e.caseId),v=D.report(e.result||{},e.project);return db.withTransaction(async c=>{
 const episode=(await c.query('SELECT status FROM prenatal_cases WHERE id=$1 FOR UPDATE',[caseId])).rows[0];if(episode?.status!=='active')throw Error('请先重新开启孕次随访再修改报告');
 const p=(await c.query('SELECT * FROM prenatal_projects WHERE case_id=$1 AND project_code=$2 FOR UPDATE',[caseId,e.project])).rows[0];if(!p)throw Error('请先添加该随访项目');if(String(new Date(p.updated_at).getTime())!==String(e.version))throw Error('报告已被更新，请重新打开');
 await c.query('UPDATE prenatal_projects SET result=$3,updated_at=now() WHERE case_id=$1 AND project_code=$2',[caseId,e.project,v]);await change(c,caseId,e.recordedBy,'report_edit',{project:e.project,before:p.result,after:v});return {ok:true};});}
async function createPlan(e){uuid(e.requestId);const caseId=id(e.caseId),assigned=text(e.assignedTo,80),focus=text(e.focus);if(!assigned)throw Error('请填写责任医护');if(!['phone','clinic','online'].includes(e.channel))throw Error('随访方式无效');
 if(!Array.isArray(e.nodes)||!e.nodes.length||e.nodes.length>7)throw Error('请选择1–7个随访节点');
 const nodes=e.nodes.map(n=>{if(!D.allowed(e.project,n.stage))throw Error('项目与随访节点不匹配');const d=D.dateValue(n.date);if(!d||d<'2000-01-01'||d>'2100-12-31')throw Error('请填写有效计划日期');return {stage:n.stage,date:d};});if(new Set(nodes.map(n=>n.stage)).size!==nodes.length)throw Error('同次计划不可重复选择节点');
 const hash=digest({caseId,project:e.project,assigned,channel:e.channel,focus,nodes});return db.withTransaction(async c=>{
 await c.query('SELECT pg_advisory_xact_lock(73429316)');const old=await cached(c,'followup_plans',e.requestId,hash);if(old)return old;
 const row=(await c.query('SELECT * FROM prenatal_cases WHERE id=$1 FOR UPDATE',[caseId])).rows[0];if(!row||row.status!=='active')throw Error('仅随访中的孕次可创建计划');
 const project=(await c.query('SELECT * FROM prenatal_projects WHERE case_id=$1 AND project_code=$2',[caseId,e.project])).rows[0];if(!project)throw Error('孕次尚未添加该项目');
 const ids=[];for(const n of nodes){
  if(n.stage==='procedure'&&(!project.result.procedure_date||n.date<project.result.procedure_date))throw Error('术后随访须先登记介入日期，计划日期不能早于手术');
  const existing=await c.query("SELECT id FROM followup_tasks WHERE prenatal_case_id=$1 AND project_code=$2 AND stage_code=$3 AND due_date=$4 AND status='pending'",[caseId,e.project,n.stage,n.date]);if(existing.rowCount)throw Error('同项目、节点和日期已有待办，请查看任务');
  const title=D.getProject(e.project).name+' · '+D.getStage(n.stage).name;
  ids.push((await c.query('INSERT INTO followup_tasks(patient_id,title,due_date,assigned_to,channel,focus,plan_key,prenatal_case_id,project_code,stage_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',[row.patient_id,title,n.date,assigned,e.channel,focus,e.requestId,caseId,e.project,n.stage])).rows[0].id);
 }const result={ok:true,created:ids.length};await c.query('INSERT INTO followup_plans(request_id,payload_hash,result) VALUES($1,$2,$3)',[e.requestId,hash,result]);await change(c,caseId,e.recordedBy,'plan_create',{project:e.project,nodes,ids});return result;
 });}
const statuses={all:'TRUE',pending:"t.status='pending'",today:"t.status='pending' AND t.due_date=(now() AT TIME ZONE 'Asia/Shanghai')::date",overdue:"t.status='pending' AND t.due_date<(now() AT TIME ZONE 'Asia/Shanghai')::date",completed:"t.status='completed'",cancelled:"t.status='cancelled'"};
async function tasks(e){const n=page(e),params=[like(e.keyword),D.getProject(e.project)?e.project:'',D.getStage(e.stage)?e.stage:''];const where=" WHERE (p.name ILIKE $1 OR p.patient_no ILIKE $1 OR c.pregnancy_no ILIKE $1 OR t.assigned_to ILIKE $1) AND ($2='' OR t.project_code=$2) AND ($3='' OR t.stage_code=$3) AND "+(statuses[e.status||'pending']||statuses.pending);const [rows,count]=await Promise.all([db.q(taskSelect+where+' ORDER BY t.due_date,t.id LIMIT 20 OFFSET $4',[...params,(n-1)*20]),db.q('SELECT count(*)::int total FROM followup_tasks t JOIN prenatal_cases c ON c.id=t.prenatal_case_id JOIN patients p ON p.id=c.patient_id'+where,params)]);return {ok:true,list:rows,total:count[0].total,page:n};}
async function record(e){uuid(e.requestId);const taskId=id(e.taskId),notes=text(e.notes,2000),next=e.nextDate?D.dateValue(e.nextDate):null;if(!notes)throw Error('请填写联系情况与处理说明');if(!['reached','unreachable','declined','cancelled'].includes(e.contact))throw Error('联系结果无效');if(e.nextDate&&(!next||next<D.today()||next>'2100-12-31'))throw Error('再次联系日期不能早于今天');
 if(e.contact==='unreachable'&&!next)throw Error('未接通须安排再次联系日期');if(['declined','cancelled'].includes(e.contact)&&next)throw Error('拒绝或取消节点无需填写下次日期');
 return db.withTransaction(async c=>{
  const owner=(await c.query('SELECT prenatal_case_id FROM followup_tasks WHERE id=$1',[taskId])).rows[0];if(!owner?.prenatal_case_id)throw Error('产前随访任务不存在');await c.query('SELECT id FROM prenatal_cases WHERE id=$1 FOR UPDATE',[owner.prenatal_case_id]);
  const t=(await c.query('SELECT t.*,c.fetus_count FROM followup_tasks t JOIN prenatal_cases c ON c.id=t.prenatal_case_id WHERE t.id=$1 FOR UPDATE OF t',[taskId])).rows[0];if(!t)throw Error('产前随访任务不存在');
  const data=e.contact==='reached'?D.clinical(e.data,t.stage_code,t.fetus_count):null;
  if(e.contact!=='reached'&&e.data&&Object.keys(e.data).length)throw Error('未联系成功不应提交临床随访结果');
  if(data){
   if(t.stage_code==='postnatal'){
    const latest=(await c.query("SELECT r.prenatal_data FROM followup_records r JOIN followup_tasks t ON t.id=r.task_id WHERE t.prenatal_case_id=$1 AND t.stage_code='outcome' AND r.contact='reached' ORDER BY r.id DESC LIMIT 1",[t.prenatal_case_id])).rows[0]?.prenatal_data;
    if(!latest||latest.fetuses.some(f=>['unknown','ongoing'].includes(f.outcome)))throw Error('请先完成本孕次的逐胎妊娠结局登记');
    for(const f of latest.fetuses){const x=data.fetuses.find(x=>x.fetus_no===f.fetus_no);if(f.outcome==='live_birth'?(x.applicability!=='live_birth'||x.birth_date!==f.outcome_date):x.applicability!=='not_liveborn')throw Error('出生后随访的逐胎状态或出生日期与妊娠结局不一致');}
    if(data.fetuses.some(f=>f.applicability==='live_birth'&&(f.child_health==='unknown'||f.evidence==='unknown'))&&!next)throw Error('儿童情况或资料来源尚未核实，请安排再次联系');
   }
   if(['notification','report'].includes(t.stage_code)&&(data.notified!=='yes'||!['completed','declined'].includes(data.counseling))&&!next)throw Error('告知/咨询尚未落实，请安排再次跟进；拒绝情况可在说明中记录');
   if(t.stage_code==='referral'&&!['completed','declined'].includes(data.diagnosis)&&!next)throw Error('诊断尚未落实，请安排再次跟进');
   if(t.stage_code==='outcome'&&data.fetuses.some(f=>['unknown','ongoing'].includes(f.outcome))&&!next)throw Error('妊娠结局未明或继续妊娠，请安排再次随访');
   if(t.stage_code==='procedure'&&data.procedure_event==='unknown'&&!next)throw Error('术后情况尚未核实，请安排再次随访');
   if(t.stage_code==='procedure'){const p=(await c.query('SELECT result FROM prenatal_projects WHERE case_id=$1 AND project_code=$2',[t.prenatal_case_id,t.project_code])).rows[0];if(p?.result.procedure_date&&((data.event_date&&data.event_date<p.result.procedure_date)||data.followup_date<p.result.procedure_date))throw Error('术后随访/事件日期不能早于介入日期');}
  }
  const hash=digest({taskId,actor:e.recordedBy,contact:e.contact,notes,next,data});const old=await c.query('SELECT payload_hash FROM followup_records WHERE request_id=$1',[e.requestId]);if(old.rowCount){if(old.rows[0].payload_hash!==hash)throw Error('请求内容已改变');return {ok:true};}if(t.status!=='pending')throw Error('任务已处理，请刷新');
  await c.query("INSERT INTO followup_records(task_id,request_id,payload_hash,operator,contact,condition,medication,appointment,notes,next_date,recorded_by,prenatal_data) VALUES($1,$2,$3,$4,$5,'unknown','unknown','unknown',$6,$7,$8,$9)",[taskId,e.requestId,hash,e.operator,e.contact,notes,next,e.recordedBy,data]);
  if(e.contact==='unreachable')await c.query('UPDATE followup_tasks SET due_date=$2 WHERE id=$1',[taskId,next]);
  else{await c.query('UPDATE followup_tasks SET status=$2,completed_at=now() WHERE id=$1',[taskId,['declined','cancelled'].includes(e.contact)?'cancelled':'completed']);
   if(next)await c.query('INSERT INTO followup_tasks(patient_id,title,due_date,assigned_to,channel,focus,plan_key,prenatal_case_id,project_code,stage_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[t.patient_id,t.title,next,t.assigned_to,t.channel,t.focus,e.requestId,t.prenatal_case_id,t.project_code,t.stage_code]);}
  return {ok:true};
 });}
async function records(e){const n=page(e),params=[like(e.keyword),D.getProject(e.project)?e.project:'',D.getStage(e.stage)?e.stage:''];const from=' FROM followup_records r JOIN followup_tasks t ON t.id=r.task_id JOIN prenatal_cases c ON c.id=t.prenatal_case_id JOIN patients p ON p.id=c.patient_id';const where=" WHERE (p.name ILIKE $1 OR p.patient_no ILIKE $1 OR c.pregnancy_no ILIKE $1) AND ($2='' OR t.project_code=$2) AND ($3='' OR t.stage_code=$3)";const [rows,count]=await Promise.all([db.q('SELECT r.*,r.next_date::text,t.title,t.project_code,t.stage_code,c.pregnancy_no,c.id case_id,p.name,p.patient_no'+from+where+' ORDER BY r.id DESC LIMIT 20 OFFSET $4',[...params,(n-1)*20]),db.q('SELECT count(*)::int total'+from+where,params)]);return {ok:true,list:rows,total:count[0].total,page:n};}
async function status(e){const caseId=id(e.id),reason=text(e.reason),status=e.status;if(!D.options.status.some(x=>x[0]===status)||!reason)throw Error('请选择状态并填写原因');return db.withTransaction(async c=>{
 const row=(await c.query('SELECT * FROM prenatal_cases WHERE id=$1 FOR UPDATE',[caseId])).rows[0];if(!row)throw Error('孕次不存在');
 if(status!=='active'){
  if((await c.query("SELECT id FROM followup_tasks WHERE prenatal_case_id=$1 AND status='pending' LIMIT 1",[caseId])).rowCount)throw Error('仍有待办任务，请先完成或取消任务后再变更档案状态');
  if(status==='closed'){
   const recs=(await c.query("SELECT r.prenatal_data,t.stage_code FROM followup_records r JOIN followup_tasks t ON t.id=r.task_id WHERE t.prenatal_case_id=$1 AND r.contact='reached' ORDER BY r.id DESC",[caseId])).rows;
   const outcome=recs.find(r=>r.stage_code==='outcome')?.prenatal_data;if(!outcome||outcome.fetuses.some(f=>['unknown','ongoing'].includes(f.outcome)||f.evidence==='unknown'))throw Error('妊娠结局或资料来源未完整核实，不能结案');
   const high=(await c.query("SELECT id FROM prenatal_projects WHERE case_id=$1 AND project_code IN ('serum','nipt') AND result->>'screen_risk'='high'",[caseId])).rowCount;
   if(high&&outcome.fetuses.some(f=>f.outcome==='live_birth'&&f.defect==='unknown'))throw Error('高风险筛查活产儿的出生缺陷情况尚未核实');
   if(high&&outcome.fetuses.some(f=>f.outcome==='live_birth')){const post=recs.find(r=>r.stage_code==='postnatal')?.prenatal_data;if(!post||outcome.fetuses.filter(f=>f.outcome==='live_birth').some(f=>!post.fetuses.some(x=>x.fetus_no===f.fetus_no&&x.applicability==='live_birth'&&x.child_health!=='unknown'&&x.evidence!=='unknown'&&x.birth_date===f.outcome_date&&(Date.parse(post.followup_date)-Date.parse(x.birth_date))/86400000>=84)))throw Error('高风险筛查活产儿需有出生后至少12周的随访记录方可结案');}
  }
 }
 await c.query('UPDATE prenatal_cases SET status=$2,close_reason=$3,updated_at=now() WHERE id=$1',[caseId,status,reason]);await change(c,caseId,e.recordedBy,'case_status',{before:row.status,after:status,reason});return {ok:true};});}
async function overview(){const [counts,totals,byProject,recent]=await Promise.all([
 db.q("SELECT count(*)::int total,count(*) FILTER(WHERE status='active')::int active,count(*) FILTER(WHERE status='lost')::int lost,count(*) FILTER(WHERE status='refused')::int refused FROM prenatal_cases"),
 db.q("SELECT count(*) FILTER(WHERE status='pending')::int pending,count(*) FILTER(WHERE status='pending' AND due_date=(now() AT TIME ZONE 'Asia/Shanghai')::date)::int today,count(*) FILTER(WHERE status='pending' AND due_date<(now() AT TIME ZONE 'Asia/Shanghai')::date)::int overdue FROM followup_tasks WHERE prenatal_case_id IS NOT NULL"),
 db.q("SELECT project_code,count(*)::int total,count(*) FILTER(WHERE result->>'screen_risk'='high')::int high,count(*) FILTER(WHERE result->>'diagnosis_result'='abnormal')::int abnormal FROM prenatal_projects GROUP BY project_code"),
 db.q(taskSelect+" WHERE t.status='pending' ORDER BY t.due_date,t.id LIMIT 6")]);
 return {ok:true,counts:counts[0],totals:totals[0],projects:byProject,due:recent};}
async function importCases(e){uuid(e.requestId);if(!['skip','update'].includes(e.strategy))throw Error('请选择重复数据处理方式');const checked=D.validateRows(e.rows),hash=digest({checked,strategy:e.strategy});return db.withTransaction(async c=>{
 await c.query('SELECT pg_advisory_xact_lock(73429315)');await c.query('SELECT pg_advisory_xact_lock(73429312)');const old=await cached(c,'prenatal_imports',e.requestId,hash);if(old)return old;
 const r={ok:true,inserted:0,updated:0,skipped:0,invalid:0,errors:[]};for(const row of checked){if(row.errors.length){r.invalid++;r.errors.push({row:row.row,errors:row.errors});continue;}const v=row.data;
  let p=(await c.query('SELECT id,name,phone FROM patients WHERE patient_no=$1',[v.patient_no])).rows[0];
  if(p&&(p.name!==v.name||p.phone!==v.phone)){r.invalid++;r.errors.push({row:row.row,errors:['病案号对应的姓名或电话与现有档案不一致，请核实后编辑基础档案']});continue;}
  if(!p)p=(await c.query("INSERT INTO patients(patient_no,name,phone,sex,birth_date,department,clinician,source) VALUES($1,$2,$3,'女',$4,$5,$6,'产前孕次表格') RETURNING id",[v.patient_no,v.name,v.phone,v.birth_date||null,v.department,v.clinician])).rows[0];
  let existing=(await c.query('SELECT * FROM prenatal_cases WHERE patient_id=$1 AND pregnancy_no=$2 FOR UPDATE',[p.id,v.pregnancy_no])).rows[0];
  if(existing&&e.strategy==='skip'){r.skipped++;continue;}
  if(existing&&existing.status!=='active'){r.invalid++;r.errors.push({row:row.row,errors:['孕次不在随访中，请先人工重新开启后更新资料']});continue;}
  if(existing&&existing.fetus_count!==v.fetus_count&&(await c.query('SELECT r.id FROM followup_records r JOIN followup_tasks t ON t.id=r.task_id WHERE t.prenatal_case_id=$1 LIMIT 1',[existing.id])).rowCount){r.invalid++;r.errors.push({row:row.row,errors:['已有随访记录，不能通过导入更改胎数']});continue;}
  if(existing){try{D.validateCase({...v,lmp:v.lmp||(existing.lmp?new Date(existing.lmp).toISOString().slice(0,10):''),edd:v.edd||(existing.edd?new Date(existing.edd).toISOString().slice(0,10):'')});}catch(err){r.invalid++;r.errors.push({row:row.row,errors:[err.message]});continue;}await c.query("UPDATE prenatal_cases SET lmp=COALESCE($2,lmp),edd=COALESCE($3,edd),referral_org=COALESCE(NULLIF($4,''),referral_org),indications=COALESCE(NULLIF($5,''),indications),fetus_count=$6,updated_at=now() WHERE id=$1",[existing.id,v.lmp||null,v.edd||null,v.referral_org,v.indications,v.fetus_count]);r.updated++;}
  else{existing=(await c.query('INSERT INTO prenatal_cases(patient_id,pregnancy_no,lmp,edd,fetus_count,referral_org,indications) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[p.id,v.pregnancy_no,v.lmp||null,v.edd||null,v.fetus_count,v.referral_org,v.indications])).rows[0];r.inserted++;}
  for(const code of v.projects)await c.query('INSERT INTO prenatal_projects(case_id,project_code) VALUES($1,$2) ON CONFLICT DO NOTHING',[existing.id,code]);await change(c,existing.id,e.recordedBy,'case_import',{row:row.row,projects:v.projects});
 }await c.query('INSERT INTO prenatal_imports(request_id,payload_hash,result) VALUES($1,$2,$3)',[e.requestId,hash,r]);return r;
 });}
async function task(e){const rows=await db.q(taskSelect+' WHERE t.id=$1',[id(e.id)]);if(!rows.length)throw Error('产前任务不存在');return {ok:true,task:rows[0]};}
async function reschedule(e){const taskId=id(e.id),due=D.dateValue(e.date),reason=text(e.reason),assigned=text(e.assignedTo,80);if(!due||due<'2000-01-01'||due>'2100-12-31'||!reason||!assigned)throw Error('请填写有效日期、责任医护与调整原因');return db.withTransaction(async c=>{const owner=(await c.query('SELECT prenatal_case_id FROM followup_tasks WHERE id=$1',[taskId])).rows[0];if(!owner?.prenatal_case_id)throw Error('产前任务不存在');await c.query('SELECT id FROM prenatal_cases WHERE id=$1 FOR UPDATE',[owner.prenatal_case_id]);const t=(await c.query('SELECT *,due_date::text FROM followup_tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];if(t.status!=='pending')throw Error('只能调整待办任务');if(t.stage_code==='procedure'){const p=(await c.query('SELECT result FROM prenatal_projects WHERE case_id=$1 AND project_code=$2',[t.prenatal_case_id,t.project_code])).rows[0];if(!p.result.procedure_date||due<p.result.procedure_date)throw Error('术后计划日期不能早于介入日期');}await c.query('UPDATE followup_tasks SET due_date=$2,assigned_to=$3 WHERE id=$1',[taskId,due,assigned]);await change(c,t.prenatal_case_id,e.recordedBy,'task_reschedule',{taskId,before:t.due_date,after:due,assigned,reason});return {ok:true};});}
const handlers={prenatal_reschedule:reschedule,prenatal_task:task,prenatal_cases:cases,prenatal_detail:detail,prenatal_save:saveCase,prenatal_report:saveReport,prenatal_plan:createPlan,prenatal_tasks:tasks,prenatal_record:record,prenatal_records:records,prenatal_status:status,prenatal_overview:overview,prenatal_import:importCases};
async function main(e){try{if(!handlers[e.action])return {ok:false,error:'未知产前随访操作'};return await handlers[e.action](e);}catch(err){if(err.code){console.error('prenatal database error',err.code);return {ok:false,error:err.code==='23505'?'该孕次或记录已存在，请刷新':'保存失败，请检查数据后重试'};}return {ok:false,error:err.message||'操作失败'};}}
module.exports={ensureSchema,main};
