(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./patient-validation'));else root.PrenatalData=factory(root.PatientData);})(typeof globalThis!=='undefined'?globalThis:this,function(P){
 const projects=[
  {code:'serum',name:'血清学产前筛查',type:'screen',hint:'记录二联/三联/四联等方法、报告风险及目标疾病。'},
  {code:'nipt',name:'无创产前筛查（cffDNA/NIPT）',type:'screen',hint:'记录 T21/T18/T13 等报告提示，高风险需追踪咨询与遗传学诊断落实。'},
  {code:'ultrasound',name:'超声产前筛查（NT/结构筛查）',type:'screen',hint:'记录筛查孕周、可疑异常及转诊落实。'},
  {code:'genetic',name:'遗传学产前诊断',type:'diagnosis',hint:'记录诊断指征、取材方式、核型/CMA/分子遗传等检测及报告结论。'},
  {code:'ultrasound_dx',name:'超声产前诊断',type:'diagnosis',hint:'记录可疑异常评估、诊断结论、咨询及妊娠结局。'}
 ];
 const stages=[
  {code:'notification',name:'筛查结果告知与咨询',scope:'screen',hint:'核实报告告知、合资格医师咨询及下一步安排；高风险不等于确诊。'},
  {code:'referral',name:'转诊与诊断落实',scope:'all',hint:'记录转入机构、到诊及遗传学/超声诊断完成情况；未落实继续追踪。'},
  {code:'procedure',name:'介入术后一周随访',scope:'genetic',hint:'国家质控包含介入取材术后一周内胎儿丢失；请核实实际情况与事件日期，不自动判定因果。',offset:7},
  {code:'report',name:'诊断结果告知与遗传咨询',scope:'diagnosis',hint:'依据正式报告记录结果告知及咨询；不确定结果保留原报告描述。'},
  {code:'outcome',name:'妊娠结局随访',scope:'all',hint:'逐胎记录妊娠结局、日期、出生情况和信息来源；未知结局继续追踪。'},
  {code:'postnatal',name:'出生后随访（含12周）',scope:'all',hint:'国家高风险筛查随访要求至少至出生后12周；按实际出生日期安排，记录儿童健康及目标疾病核实。',offset:84},
  {code:'custom',name:'个体化补充随访',scope:'all',hint:'由医护根据具体情况制定随访内容与日期。'}
 ];
 const options={
  screen_risk:[['unknown','未登记'],['low','低风险'],['borderline','临界风险'],['high','高风险'],['suspected','超声可疑异常'],['no_result','未获有效结果']],
  diagnosis_result:[['unknown','未登记'],['normal','未见报告目标异常'],['abnormal','异常'],['uncertain','意义不明确/待核实'],['no_result','未获有效结果']],
  notified:[['unknown','未核实'],['yes','已告知'],['no','尚未告知']],
  counseling:[['unknown','未核实'],['completed','已接受医师咨询'],['scheduled','已预约咨询'],['declined','拒绝咨询'],['pending','待落实']],
  referral:[['unknown','未核实'],['arranged','已安排转诊'],['attended','已到诊'],['pending','尚未到诊'],['declined','拒绝转诊']],
  diagnosis:[['unknown','未核实'],['completed','已完成诊断'],['scheduled','已预约诊断'],['pending','待落实'],['declined','拒绝诊断']],
  procedure_event:[['unknown','未核实'],['none','未报告相关异常'],['symptoms','报告不适/已转医护评估'],['loss','报告胎儿丢失']],
  outcome:[['unknown','结局未明'],['ongoing','继续妊娠'],['live_birth','活产'],['stillbirth','死胎/死产'],['miscarriage','自然流产'],['termination','终止妊娠']],
  defect:[['unknown','未核实'],['none_reported','未报告出生缺陷'],['suspected','疑似出生缺陷'],['confirmed','已确诊出生缺陷']],
  child_health:[['unknown','未核实'],['no_issue_reported','未报告健康问题'],['followup','存在问题/正在随诊'],['deceased','死亡']],
  evidence:[['unknown','未核实'],['family','孕妇/家属自述'],['record','病历或正式报告'],['institution','医疗机构反馈']],
  confirmation:[['unknown','未核实'],['confirmed','目标疾病确诊'],['excluded','目标疾病排除'],['pending','进一步核实中']],
  status:[['active','随访中'],['closed','已结案'],['lost','失访'],['refused','拒绝继续随访']]
 };
 const fields=[...P.fields.filter(f=>['patient_no','name','phone','birth_date','department','clinician'].includes(f.key)).map(f=>({...f,label:f.key==='name'?'孕妇姓名':f.key==='department'?'管理科室':f.label,aliases:[...f.aliases,...(f.key==='name'?['孕妇姓名']:f.key==='department'?['管理科室']:[])]})),
  {key:'pregnancy_no',label:'孕次编号',required:true,max:64,aliases:['孕次编号','妊娠编号','pregnancyno']},
  {key:'lmp',label:'末次月经',max:30,aliases:['末次月经','末次月经日期','lmp']},
  {key:'edd',label:'预产期',max:30,aliases:['预产期','edd']},
  {key:'fetus_count',label:'胎数',required:true,max:1,aliases:['胎数','fetuscount']},
  {key:'referral_org',label:'来源机构',max:120,aliases:['来源机构','转诊机构','referralorg']},
  {key:'projects',label:'随访项目',required:true,max:200,aliases:['随访项目','检查项目','projects']},
  {key:'indications',label:'诊断指征/建档说明',max:1000,aliases:['诊断指征/建档说明','诊断指征','建档说明','indications']}
 ];
 const getProject=c=>projects.find(p=>p.code===c);
 const getStage=c=>stages.find(s=>s.code===c);
 function allowed(project,stage){const p=getProject(project),s=getStage(stage);return !!p&&!!s&&(s.scope==='all'||s.scope===p.type||s.scope===p.code);}
 function str(v,max,label){if(v==null)return '';if(!['string','number'].includes(typeof v))throw Error(label+'格式不正确');v=String(v).trim();if(v.length>max)throw Error(label+'超过长度限制');return v;}
 function date(v,label,future=false){if(v==null||v==='')return '';const d=P.dateValue(v);if(!d||d<'1900-01-01'||d>(future?'2100-12-31':P.today()))throw Error(label+'日期无效'+(future?'':'或晚于今天'));return d;}
 function enumeration(v,key){v=v||'unknown';if(!options[key].some(x=>x[0]===v))throw Error('随访选项无效：'+key);return v;}
 function validateCase(c){const pregnancy_no=str(c.pregnancy_no,64,'孕次编号').toUpperCase();if(!/^[A-Z0-9][A-Z0-9._/-]{0,63}$/.test(pregnancy_no))throw Error('孕次编号须为字母、数字、点、横线、斜线或下划线');
  const lmp=date(c.lmp,'末次月经'),edd=date(c.edd,'预产期',true),fetus_count=Number(c.fetus_count);
  if(lmp&&edd&&edd<=lmp)throw Error('预产期须晚于末次月经');if(!Number.isInteger(fetus_count)||fetus_count<1||fetus_count>6)throw Error('胎数须为1–6');
  const selected=Array.isArray(c.projects)?[...new Set(c.projects)]:[];if(!selected.length||selected.some(p=>!getProject(p)))throw Error('请选择至少一个有效随访项目');
  return {pregnancy_no,lmp,edd,fetus_count,referral_org:str(c.referral_org,120,'来源机构'),indications:str(c.indications,1000,'诊断指征'),projects:selected};
 }
 function report(v,code){const p=getProject(code);if(!p)throw Error('随访项目无效');const r={method:str(v.method,120,'检查方法'),target:str(v.target,300,'目标疾病/异常'),sample_date:date(v.sample_date,'取样/检查日期'),report_date:date(v.report_date,'报告日期'),gestation:str(v.gestation,20,'检查孕周'),summary:str(v.summary,1500,'报告摘要'),procedure_date:date(v.procedure_date,'介入日期'),procedure_method:str(v.procedure_method,80,'取材方式')};
  if(r.sample_date&&r.report_date&&r.report_date<r.sample_date)throw Error('报告日期不能早于检查日期');
  if(r.gestation&&!/^([0-9]|[1-3][0-9]|4[0-5])([+][0-6])?$/.test(r.gestation))throw Error('孕周请填写如 16+3');
  if(p.type==='screen')r.screen_risk=enumeration(v.screen_risk,'screen_risk');else r.diagnosis_result=enumeration(v.diagnosis_result,'diagnosis_result');
  if(code==='genetic'&&(!!r.procedure_date!==!!r.procedure_method))throw Error('介入日期与取材方式需同时登记');if(r.procedure_method&&!['cvs','amniocentesis','cordocentesis','other'].includes(r.procedure_method))throw Error('取材方式无效');
  if(code!=='genetic'&&(r.procedure_date||r.procedure_method))throw Error('介入信息仅适用于遗传学诊断项目');return r;
 }
 function clinical(v,stage,count){v=v||{};const r={evidence:enumeration(v.evidence,'evidence'),source_detail:str(v.source_detail,300,'资料来源'),followup_date:date(v.followup_date,'实际随访日期')};if(!r.followup_date)throw Error('请填写实际随访日期');
  if(['notification','report'].includes(stage)){r.notified=enumeration(v.notified,'notified');r.counseling=enumeration(v.counseling,'counseling');r.counseling_date=date(v.counseling_date,'咨询日期');r.counseling_org=str(v.counseling_org,120,'咨询机构/医师');if(r.counseling==='completed'&&(!r.counseling_date||!r.counseling_org))throw Error('已接受咨询时请填写咨询日期和机构/医师');}
  if(stage==='referral'){r.referral=enumeration(v.referral,'referral');r.diagnosis=enumeration(v.diagnosis,'diagnosis');r.institution=str(v.institution,120,'转诊/诊断机构');r.visit_date=date(v.visit_date,'到诊/诊断日期');if((r.referral==='attended'||r.diagnosis==='completed')&&(!r.institution||!r.visit_date))throw Error('已到诊或完成诊断时，请填写机构和日期');}
  if(stage==='procedure'){r.procedure_event=enumeration(v.procedure_event,'procedure_event');r.event_date=date(v.event_date,'事件日期');r.event_detail=str(v.event_detail,1000,'术后情况');if(['loss','symptoms'].includes(r.procedure_event)&&(!r.event_date||!r.event_detail))throw Error('报告术后异常时请填写事件日期和情况');}
  if(['outcome','postnatal'].includes(stage)){
   if(!Array.isArray(v.fetuses)||v.fetuses.length!==count)throw Error('请按胎数逐胎填写结局/儿童情况');
   r.fetuses=v.fetuses.map((f,i)=>{const x={fetus_no:i+1,evidence:enumeration(f.evidence,'evidence'),notes:str(f.notes,800,'逐胎说明')};
    if(stage==='outcome'){x.outcome=enumeration(f.outcome,'outcome');x.outcome_date=date(f.outcome_date,'结局日期');x.defect=enumeration(f.defect,'defect');x.birth_weight=str(f.birth_weight,8,'出生体重');if(x.birth_weight&&(!/^[0-9]+$/.test(x.birth_weight)||Number(x.birth_weight)<1||Number(x.birth_weight)>10000))throw Error('出生体重请输入1–10000克或留空');if(!['unknown','ongoing'].includes(x.outcome)&&!x.outcome_date)throw Error('已发生的妊娠结局须填写日期');if(['unknown','ongoing'].includes(x.outcome)&&(x.outcome_date||x.birth_weight||x.defect!=='unknown'))throw Error('结局未明或继续妊娠时，不填写出生日期、体重及出生缺陷结果');}
    else{x.applicability=f.applicability||'live_birth';if(!['live_birth','not_liveborn'].includes(x.applicability))throw Error('出生后随访适用状态无效');if(x.applicability==='not_liveborn'){if(!x.notes)throw Error('非活产胎儿请注明妊娠结局及依据');return x;}x.birth_date=date(f.birth_date,'出生日期');x.child_health=enumeration(f.child_health,'child_health');x.confirmation=enumeration(f.confirmation,'confirmation');if(!x.birth_date)throw Error('出生后随访请填写每个儿童的实际出生日期');if(x.birth_date>r.followup_date)throw Error('随访日期不能早于出生日期');if(['confirmed','excluded'].includes(x.confirmation)&&(!['record','institution'].includes(x.evidence)||!x.notes))throw Error('目标疾病确诊/排除须注明病历报告或机构依据');}
    const event=x.outcome_date||x.birth_date;if(event&&event>r.followup_date)throw Error('结局日期不能晚于实际随访日期');return x;
   });
  }for(const k of ['counseling_date','visit_date','event_date'])if(r[k]&&r[k]>r.followup_date)throw Error('咨询、到诊或事件日期不能晚于实际随访日期');return r;
 }
 function guessMapping(headers){const out={};fields.forEach(f=>out[f.key]=headers.findIndex(h=>f.aliases.includes(String(h).toLowerCase().replace(/[ _*]/g,''))));return out;}
 function validateRows(rows){if(!Array.isArray(rows)||!rows.length||rows.length>2000)throw Error('每次请提供1–2000行孕次数据');const seen=new Set();return rows.map((v,i)=>{const errors=[],data={};for(const f of fields){try{data[f.key]=str(v[f.key],f.max,f.label);}catch(e){errors.push(e.message);data[f.key]='';}}
  const p=P.validateRows([{...v,sex:'女',discharge_date:''}])[0];errors.push(...p.errors);Object.assign(data,Object.fromEntries(['patient_no','name','phone','birth_date','department','clinician'].map(k=>[k,p.data[k]])));
  const codes=String(v.projects||'').split(/[,，;；、]/).map(x=>x.trim()).filter(Boolean).map(x=>projects.find(p=>p.code===x||p.name===x)?.code||x);
  try{Object.assign(data,validateCase({...v,projects:codes}));}catch(e){errors.push(e.message);}
  const key=data.patient_no+'|'+data.pregnancy_no;if(!errors.length&&seen.has(key))errors.push('表内同一病案号和孕次编号重复');if(!errors.length)seen.add(key);
  return {row:Number.isSafeInteger(v.row)?v.row:i+2,data,errors};});}
 return {projects,stages,options,fields,getProject,getStage,allowed,validateCase,report,clinical,guessMapping,validateRows,today:P.today,dateValue:P.dateValue};
});
