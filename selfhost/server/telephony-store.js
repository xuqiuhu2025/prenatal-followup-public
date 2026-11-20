'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
const isDemo=row=>/DEMO|演示|虚构/i.test([row.patient_no,row.pregnancy_no,row.name,row.tags,row.source].join(' '));
class Store {
  constructor(db) { this.db=db; }
  async ensureSchema() { const f=path.join(__dirname,'telephone-schema.sql');await this.db.q(fs.readFileSync(fs.existsSync(f)?f:path.join(__dirname,'../init/07-telephone.sql'),'utf8')); }
  async recover() {
    // Single telephone controller instance. Asterisk enforces its own hard call timeout.
    return this.db.q("UPDATE telephone_calls SET status='interrupted',reason='controller_restarted',outcome=CASE WHEN priority='urgent' THEN 'urgent' ELSE 'needs_review' END,ended_at=now() WHERE status IN ('dialing','answered') RETURNING id");
  }
  async create(e,config) {
    if(!uuid(e.requestId))throw Error('请求标识无效');
    const taskId=e.taskId==null?null:String(e.taskId);
    if(taskId&&!/^[1-9][0-9]{0,15}$/.test(taskId))throw Error('随访任务编号无效');
    if(!taskId&&(!/^1[3-9][0-9]{9}$/.test(e.phone||'')||e.stage!=='postnatal'||!Number.isInteger(e.count)||e.count<1||e.count>6))throw Error('请填写有效测试号码和胎数');
    if(e.authorized!==true)throw Error('请确认已获对方同意进行机器人试拨');
    const hash=crypto.createHash('sha256').update(JSON.stringify({actor:String(e.recordedBy),taskId,phone:taskId?null:e.phone,stage:taskId?null:e.stage,count:taskId?null:e.count})).digest('hex');
    return this.db.withTransaction(async c=>{
      await c.query('SELECT pg_advisory_xact_lock(73429317)');
      const previous=(await c.query('SELECT payload_hash,call_id FROM telephone_requests WHERE request_id=$1',[e.requestId])).rows[0];
      if(previous){if(previous.payload_hash!==hash)throw Error('同一次拨打请求内容已改变');const old=(await c.query('SELECT * FROM telephone_calls WHERE id=$1',[previous.call_id])).rows[0];return {row:old,existing:true};}
      let phone=e.phone,stage=e.stage,count=e.count;
      if(taskId){
        const t=(await c.query('SELECT t.*,c.status case_status,c.fetus_count,c.pregnancy_no,p.phone,p.name,p.patient_no,p.tags,p.source FROM followup_tasks t JOIN prenatal_cases c ON c.id=t.prenatal_case_id JOIN patients p ON p.id=t.patient_id WHERE t.id=$1 FOR UPDATE OF t,c,p',[taskId])).rows[0];
        if(!t||t.status!=='pending'||t.case_status!=='active'||t.channel!=='phone')throw Error('请选择待完成的电话随访任务');
        if(isDemo(t))throw Error('演示档案不得拨打电话');
        if(t.stage_code!=='postnatal')throw Error('电话试用目前先开放产后随访');
        phone=t.phone;stage=t.stage_code;count=t.fetus_count;
      }
      if(!config.allowlist.includes(phone))throw Error('该号码尚未加入服务器的授权试拨清单');
      if((await c.query('SELECT phone FROM telephone_suppressions WHERE phone=$1',[phone])).rowCount||(await c.query("SELECT id FROM telephone_calls WHERE phone=$1 AND outcome='declined' AND created_at>now()-interval '365 days' LIMIT 1",[phone])).rowCount)throw Error('对方已要求停止机器人来电，请由医护处理');
      if(taskId&&(await c.query("SELECT id FROM telephone_calls WHERE task_id=$1 AND outcome='declined' LIMIT 1",[taskId])).rowCount)throw Error('该节点已拒绝本次随访，请由医护处理');
      const active=(await c.query("SELECT count(*)::int AS n FROM telephone_calls WHERE status IN ('dialing','answered')")).rows[0].n;
      if(active>=config.maxConcurrent)throw Error('已有通话正在进行，请稍后再试');
      const recent=(await c.query("SELECT count(*)::int AS n, max(created_at) AS last FROM telephone_calls WHERE phone=$1 AND created_at>now()-interval '24 hours'",[phone])).rows[0];
      if(recent.n>=3||recent.last&&Date.now()-new Date(recent.last).getTime()<600000)throw Error('同一号码至少间隔10分钟，24小时内最多试拨3次');
      const row=(await c.query('INSERT INTO telephone_calls(id,request_id,payload_hash,task_id,created_by,phone,stage,fetus_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[crypto.randomUUID(),e.requestId,hash,taskId,e.recordedBy,phone,stage,count])).rows[0];
      await c.query('INSERT INTO telephone_requests(request_id,payload_hash,call_id) VALUES($1,$2,$3)',[e.requestId,hash,row.id]);
      await c.query("INSERT INTO telephone_events(call_id,kind,detail) VALUES($1,'dial_requested',$2)",[row.id,{actor:String(e.recordedBy),pilot:true}]);
      if(taskId)await c.query("INSERT INTO prenatal_changes(case_id,actor_id,action,detail) SELECT t.prenatal_case_id,$2,'telephone_call_requested',$3 FROM followup_tasks t WHERE t.id=$1 AND t.prenatal_case_id IS NOT NULL",[taskId,e.recordedBy,{callId:row.id,stage,mode:'pilot'}]);
      return {row,existing:false};
    });
  }
  async event(id,kind,detail={}) { await this.db.q('INSERT INTO telephone_events(call_id,kind,detail) VALUES($1,$2,$3)',[id,kind,detail]); }
  async eventByCallId(id,kind,detail={}) {if(!uuid(id))return;const row=(await this.db.q('SELECT id FROM telephone_calls WHERE id=$1',[id]))[0];if(row)await this.event(id,kind,detail);}
  async answered(id) {await this.db.q("UPDATE telephone_calls SET status='answered',answered_at=COALESCE(answered_at,now()) WHERE id=$1 AND status='dialing'",[id]);}
  async draft(id,draft) {await this.db.q("UPDATE telephone_calls SET draft=$2,priority=$3 WHERE id=$1 AND status IN ('dialing','answered')",[id,draft,draft.outcome==='urgent'?'urgent':'normal']);}
  async suppress(id,phone) {await this.db.q("INSERT INTO telephone_suppressions(phone,call_id,reason) VALUES($1,$2,'受访者要求停止来电') ON CONFLICT(phone) DO NOTHING",[phone,id]);}
  async finish(id,status,reason,draft) {
    return this.db.withTransaction(async c=>{
      const r=await c.query("UPDATE telephone_calls SET status=$2,reason=$3,outcome=$4,draft=$5,priority=$6,ended_at=COALESCE(ended_at,now()) WHERE id=$1 AND status IN ('dialing','answered') RETURNING id",[id,status,reason,draft?.outcome||'needs_review',draft||{},draft?.outcome==='urgent'?'urgent':'normal']);
      if(r.rowCount)await c.query("INSERT INTO telephone_events(call_id,kind,detail) VALUES($1,'ended',$2)",[id,{status,reason}]);
    });
  }
  async list(e) {
    const page=Math.max(1,Math.min(10000,Number.parseInt(e.page)||1));
    const rows=await this.db.q("SELECT c.id,c.task_id,c.phone,c.stage,c.status,c.outcome,c.reason,c.priority,c.review_status,c.created_at,c.answered_at,c.ended_at,p.name,t.title FROM telephone_calls c LEFT JOIN followup_tasks t ON t.id=c.task_id LEFT JOIN patients p ON p.id=t.patient_id ORDER BY (c.priority='urgent' AND c.review_status='pending') DESC,c.created_at DESC LIMIT 21 OFFSET $1",[(page-1)*20]);
    return {ok:true,list:rows.slice(0,20).map(r=>({...r,phone:r.phone.slice(0,3)+'****'+r.phone.slice(-4)})),more:rows.length>20,page};
  }
  async reviewAudit(e) {const n=Math.max(1,Math.min(10000,Number.parseInt(e.page)||1));const rows=await this.db.q('SELECT a.id,a.actor_id,u.display_name,a.action,a.detail,a.created_at FROM telephone_review_audit a JOIN staff_accounts u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 50 OFFSET $1',[(n-1)*50]);return {ok:true,list:rows,page:n};}
  async detail(id) {
    if(!uuid(id))throw Error('通话编号无效');
    const row=(await this.db.q('SELECT c.*,p.name,t.title FROM telephone_calls c LEFT JOIN followup_tasks t ON t.id=c.task_id LEFT JOIN patients p ON p.id=t.patient_id WHERE c.id=$1',[id]))[0];
    if(!row)throw Error('通话记录不存在');
    delete row.payload_hash;delete row.request_id;row.phone=row.phone.slice(0,3)+'****'+row.phone.slice(-4);
    return {ok:true,call:row,events:await this.db.q('SELECT kind,detail,created_at FROM telephone_events WHERE call_id=$1 ORDER BY id LIMIT 500',[id])};
  }
  async review(e) {
    if(!uuid(e.id)||typeof e.note!=='string'||!e.note.trim()||e.note.length>2000)throw Error('请填写审核与后续处理说明（1–2000字）');
    return this.db.withTransaction(async c=>{
      const row=(await c.query('SELECT * FROM telephone_calls WHERE id=$1 FOR UPDATE',[e.id])).rows[0];
      if(!row||['dialing','answered'].includes(row.status))throw Error('请在通话结束后审核');
      if(row.review_status==='reviewed')return {ok:true};
      await c.query("UPDATE telephone_calls SET review_status='reviewed',reviewed_by=$2,reviewed_at=now(),review_note=$3 WHERE id=$1",[e.id,e.recordedBy,e.note.trim()]);
      await c.query("INSERT INTO telephone_events(call_id,kind,detail) VALUES($1,'reviewed',$2)",[e.id,{actor:String(e.recordedBy),note:e.note.trim()}]);
      await c.query('INSERT INTO telephone_review_audit(actor_id,call_id,action,detail) VALUES($1,$2,$3,$4)',[e.recordedBy,e.id,'reviewed',{note:e.note.trim()}]);
      if(row.task_id)await c.query("INSERT INTO prenatal_changes(case_id,actor_id,action,detail) SELECT t.prenatal_case_id,$2,'telephone_call_reviewed',$3 FROM followup_tasks t WHERE t.id=$1 AND t.prenatal_case_id IS NOT NULL",[row.task_id,e.recordedBy,{callId:e.id,note:e.note.trim()}]);
      return {ok:true};
    });
  }
}
module.exports={Store,uuid,isDemo};
