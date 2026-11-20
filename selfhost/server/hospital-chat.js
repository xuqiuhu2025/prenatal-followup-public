const db=require('./db');
const WELCOME='您好，我是产前随访服务助手。可以介绍筛查与诊断的区别、转诊准备、妊娠结局和出生后随访流程。个人报告判读、诊断和处理方案请由产前诊断中心医师确认；急症请及时就医。';
function replyFor(message,history){
 const t=message.trim();
 if(/胸痛|呼吸困难|喘不过气|意识不清|昏迷|大出血|大量出血|剧烈腹痛|胎动减少|破水|流水|自杀|不想活/.test(t))return '如出现大量阴道出血、剧烈腹痛、阴道流水、明显胎动减少、呼吸困难或意识异常，请及时联系产科急诊；症状严重时立即拨打120，不要等待线上随访回复。';
 if(/高风险|临界|低风险|唐筛|无创|NIPT|cffDNA|筛查/i.test(t))return '产前筛查用于评估特定疾病的风险，高风险不等于确诊，低风险也不能排除所有疾病。请携带完整报告按通知到产前诊断中心接受咨询，由医师结合孕周和具体情况安排后续检查。随访会核实结果是否告知、咨询和转诊是否落实，再追踪妊娠结局。';
 if(/羊穿|羊水|穿刺|绒毛|脐带血|术后/.test(t))return '介入性产前诊断后的注意事项请以实施操作医院的医嘱为准。随访会核实操作日期、术后一周内情况及是否出现异常。若出现阴道出血、流水、发热或明显腹痛，请及时联系操作医院或产科急诊。';
 if(/结局|出生|分娩|12周|十二周|宝宝|孩子/.test(t))return '结局随访通常了解妊娠是否结束、实际日期、分娩和儿童情况；双胎或多胎需分别记录。高风险产前筛查的随访应至少延续到分娩后12周，了解出生缺陷及儿童健康情况。请准备出生记录、检查报告或就诊资料，具体联系时间由中心医护确认。';
 if(/药|漏服|剂量|停服|副作用/.test(t))return '孕期用药请遵循医生处方，不要自行停药、加量或补双倍剂量。可记录药名、服用时间及不适，联系开药医生或药师确认。';
 if(/诊断|复诊|预约|挂号|检查|报告|转诊|咨询/.test(t))return '就诊前可准备筛查或诊断报告、超声报告、既往病历、孕周与预产期资料，以及家族史和相关检查资料。由有资质的医师解释报告、评估检查适应证并提供咨询。请通过医院官方渠道确认预约、检查准备和转诊安排；本页面不能代为挂号。';
 if(/人工|医生|护士|联系|电话/.test(t))return '请使用就诊资料上的中心电话或医院官方渠道联系随访医护。本页面提供一般流程说明，不会自动拨打电话，也不代表医护已收到您的请求。';
 if(/你好|谢谢|再见|挂断|结束/.test(t))return '您好，祝您孕程顺利。需要了解产前筛查、诊断准备或结局随访时，可以继续问我。';
 if(history.length&&/怎么|如何|这个|具体/.test(t)){const last=history.filter(m=>m.role==='user').slice(-1)[0];if(last&&last.content!==t)return replyFor(last.content,[]);}
 return '我可以介绍产前筛查、转诊与诊断准备、术后随访、妊娠结局及出生后随访。请告诉我您想了解哪一部分；个人报告判读和诊疗方案请由您的产前诊断中心医师评估。';
}
async function markInterruptedReply(session,reply){
 if(typeof reply!=='string'||!reply.trim()||reply.length>500)return false;
 const rows=await db.q(
  `UPDATE hospital_messages SET content=$3 || content
   WHERE id=(SELECT id FROM hospital_messages WHERE session_id=$1 ORDER BY id DESC LIMIT 1)
     AND role='assistant' AND content=$2 RETURNING id`,
  [session,reply,'（语音播报被插话打断，患者未完整听到）']
 );
 return rows.length>0;
}
async function main(e){try{
 const session=String(e.sessionId||'');if(!/^h_[a-f0-9-]{36}$/i.test(session))return {ok:false,error:'会话无效，请刷新页面'};
 if(['start','history','poll'].includes(e.action)){
  const rows=await db.q('SELECT role,content,created_at FROM (SELECT * FROM hospital_messages WHERE session_id=$1 ORDER BY id DESC LIMIT 60) m ORDER BY id',[session]);
  return {ok:true,status:'open',messages:rows.length?rows.map(r=>({role:r.role,content:r.content,createdAt:new Date(r.created_at).getTime()})):[{role:'assistant',content:WELCOME}]};
 }
 if(e.action!=='chat')return {ok:false,error:'请通过医院官方渠道联系医护'};
 const message=String(e.message||'').trim();if(!message||message.length>1000)return {ok:false,error:'请输入 1–1000 字的问题'};
 if(typeof e.interruptedReply==='string')await markInterruptedReply(session,e.interruptedReply);
 const history=await db.q('SELECT role,content FROM (SELECT * FROM hospital_messages WHERE session_id=$1 ORDER BY id DESC LIMIT 10) m ORDER BY id',[session]);
 const reply=replyFor(message,history);
 await db.withTransaction(async c=>{await c.query('INSERT INTO hospital_messages(session_id,role,content) VALUES($1,$2,$3),($1,$4,$5)',[session,'user',message,'assistant',reply]);});
 return {ok:true,reply,intent:'followup',route:'followup',actions:[]};
}catch(err){console.error('hospital chat error',err.code||err.message);return {ok:false,error:'服务暂不可用，请稍后重试'};}}
module.exports={main,replyFor,markInterruptedReply};
