(function(root, factory) {
  if(typeof module === 'object' && module.exports) module.exports = factory();
  else root.PatientData = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const fields = [
    {key:'patient_no',label:'病案号',required:true,max:64,aliases:['病案号','患者编号','住院号','patientno','patientid']},
    {key:'name',label:'患者姓名',required:true,max:80,aliases:['患者姓名','姓名','name']},
    {key:'phone',label:'联系电话',required:true,max:40,aliases:['联系电话','手机号','手机号码','手机','电话','phone','mobile']},
    {key:'sex',label:'性别',max:8,aliases:['性别','sex','gender']},
    {key:'birth_date',label:'出生日期',max:30,aliases:['出生日期','生日','birthdate','birthday']},
    {key:'department',label:'出院科室',max:80,aliases:['出院科室','科室','department']},
    {key:'clinician',label:'责任医护',max:80,aliases:['责任医护','责任医生','主治医生','医生','clinician','doctor']},
    {key:'discharge_date',label:'出院日期',max:30,aliases:['出院日期','出院时间','dischargedate']},
    {key:'diagnosis',label:'出院诊断',max:300,aliases:['出院诊断','诊断','diagnosis']},
    {key:'tags',label:'管理标签',max:160,aliases:['管理标签','患者标签','标签','tags']},
    {key:'notes',label:'备注',max:1000,aliases:['备注','说明','notes','remark']}
  ];
  function today() { return new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}); }
  function isDemoRecord(record) {
    const patientNo=record&&typeof record==='object'?record.patient_no:record;
    return /^DEMO(?:[-_]|$)/i.test(String(patientNo||''));
  }
  function dialLink(phone,label,record,escapeHtml) {
    const esc=typeof escapeHtml==='function'?escapeHtml:String;
    if(isDemoRecord(record))return '<span class="muted demo-no-dial">演示数据 · 禁止拨号</span>';
    if(!/^1[3-9]\d{9}$/.test(String(phone||'')))return '';
    return '<a class="text-link dial-link" href="tel:+86'+phone+'" aria-label="拨打 '+phone+'">'+esc(label||'一键拨号')+'</a>';
  }
  function dateValue(value) {
    if (value === '' || value == null) return '';
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 61 || value > 100000) return null;
      return new Date(Date.UTC(1899,11,30) + Math.floor(value)*86400000).toISOString().slice(0,10);
    }
    const s=String(value).trim().replace(/[/.年]/g,'-').replace('月','-').replace('日','');
    const match=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if(!match) return null;
    const iso=match[1]+'-'+match[2].padStart(2,'0')+'-'+match[3].padStart(2,'0');
    const t=new Date(iso+'T00:00:00Z');
    return Number.isFinite(t.getTime()) && t.toISOString().slice(0,10)===iso ? iso : null;
  }
  function guessMapping(headers) {
    const m={};fields.forEach(f=>{m[f.key]=headers.findIndex(h=>f.aliases.includes(String(h).toLowerCase().replace(/\s|_|\*|（必填）|\(必填\)/g,'')));});return m;
  }
  function validateRows(rows) {
    if(!Array.isArray(rows)||!rows.length||rows.length>2000) throw Error('每次请提供 1–2000 行患者数据');
    const seen=new Set(), now=today();
    return rows.map((row,i)=>{
      row=row&&typeof row==='object'?row:{};const data={},errors=[];
      fields.forEach(f=>{
        let v=row[f.key];if(v!=null && typeof v!=='string' && typeof v!=='number'){errors.push(f.label+'格式不正确');v='';}
        data[f.key]=String(v??'').trim();
        if(f.required&&!data[f.key]) errors.push(f.label+'不能为空');
        if(data[f.key].length>f.max) errors.push(f.label+'最多 '+f.max+' 个字符');
      });
      data.patient_no=data.patient_no.toUpperCase();
      if(data.patient_no&&!/^[A-Z0-9][A-Z0-9._/-]{0,63}$/.test(data.patient_no))errors.push('病案号仅支持字母、数字、点、横线、斜线和下划线');
      data.phone=data.phone.replace(/[\s()（）-]/g,'').replace(/^(?:\+86|0086)(?=1\d{10}$)/,'');
      if(data.phone&&!/^1[3-9]\d{9}$/.test(data.phone))errors.push('联系电话须为 11 位中国大陆手机号');
      if(data.sex&&!['男','女','未知'].includes(data.sex)) errors.push('性别请填写男、女或未知');
      ['birth_date','discharge_date'].forEach(k=>{
        const value=dateValue(row[k]);data[k]=value||'';
        if(value===null)errors.push((k==='birth_date'?'出生日期':'出院日期')+'格式应为 YYYY-MM-DD');
        if(value && (value<'1900-01-01'||value>now))errors.push((k==='birth_date'?'出生日期':'出院日期')+'须在 1900 年至今天之间');
      });
      if(data.birth_date&&data.discharge_date&&data.birth_date>data.discharge_date)errors.push('出院日期不能早于出生日期');
      if(!errors.length&&seen.has(data.patient_no))errors.push('表内病案号重复，保留第一条有效记录');
      if(!errors.length)seen.add(data.patient_no);
      return {row:Number.isSafeInteger(row.row)&&row.row>0?row.row:i+2,data,errors};
    });
  }
  return {fields,today,dateValue,guessMapping,validateRows,isDemoRecord,dialLink};
});
