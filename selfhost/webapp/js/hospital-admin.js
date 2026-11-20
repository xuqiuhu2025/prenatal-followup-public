(function(){
'use strict';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function uuid(){const b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;const s=Array.from(b,n=>n.toString(16).padStart(2,'0')).join('');return s.slice(0,8)+'-'+s.slice(8,12)+'-'+s.slice(12,16)+'-'+s.slice(16,20)+'-'+s.slice(20);}
let token=sessionStorage.getItem('hospital_admin_token')||'',currentUser=null,active='prenatal_overview',version=0,modalBusy=false,modalVersion=0,toastTimer;
const pages={calling:'电话与语音随访',prenatal_overview:'中心总览',prenatal_cases:'孕次档案',prenatal_tasks:'产前随访任务',prenatal_records:'产前随访记录',prenatal_library:'项目与规范',overview:'随访总览',patients:'患者档案',tasks:'随访任务',records:'随访记录',accounts:'账号管理'};
const state={patients:1,tasks:1,records:1,status:'pending',tasksList:[]};
const labels={pending:'待完成',completed:'已完成',cancelled:'已取消',reached:'已联系',unreachable:'未接通',declined:'拒绝随访',stable:'恢复平稳',attention:'需医护关注',urgent:'已建议紧急就医',unknown:'未评估',as_directed:'按医嘱用药',issue:'用药有问题',not_applicable:'无相关用药',scheduled:'已安排复诊',needed:'待安排复诊',not_needed:'暂不需复诊',phone:'电话随访',clinic:'门诊随访',online:'线上随访'};
const pill=(v,label)=>'<span class="pill '+esc(v)+'">'+esc(label||labels[v]||v)+'</span>';
const when=v=>new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const empty=(text,icon='calendar')=>'<div class="empty-state"><span data-icon="'+icon+'"></span>'+text+'</div>';
function toast(t){$('toast').textContent=t;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4000);}
function clearLogin(){window.CallingUI?.stop();window.TelephoneUI?.stop();token='';currentUser=null;sessionStorage.removeItem('hospital_admin_token');version++;modalVersion++;document.querySelectorAll('dialog[open]').forEach(d=>d.close());$('adminShell').style.display='none';$('loginMask').style.display='flex';$('pwdInput').value='';$('usernameInput').focus();}
async function logout(){try{if(token)await call('logout');}catch(e){toast(e.message);}finally{clearLogin();}}
async function api(action,data={},options={}){
 const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,options.timeoutMs||110000);
 options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
 try{
  const response=await fetch((window.CS_CONFIG.gateway||'')+'/cs-admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,token,...data}),signal:controller.signal});
  if(!response.ok){const e=Error('服务连接失败（'+response.status+'），请重试');e.retryable=[502,503,504].includes(response.status);throw e;}
  const r=await response.json();if(r.unauthorized){clearLogin();throw Error('登录已失效，请重新登录');}return r;
 }catch(e){
  if(options.signal?.aborted&&(e.name==='AbortError'||e.name==='TimeoutError')){const err=Error('请求已取消');err.cancelled=true;throw err;}
  if(e.name==='AbortError'||e.name==='TimeoutError'||e instanceof TypeError){const err=Error(navigator.onLine===false?'网络已断开，请恢复网络后重试。':e.name==='AbortError'||e.name==='TimeoutError'?'服务响应超时，请重试；本次输入已保留。':'暂时无法连接随访服务，请检查网络后重试。若持续失败，请刷新页面并确认 HTTPS 连接可用。');err.retryable=true;throw err;}
  if(e instanceof SyntaxError){const err=Error('服务返回内容不完整，请重试。');err.retryable=true;throw err;}throw e;
 }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}
async function call(action,data,options){const r=await api(action,data,options);if(!r.ok)throw Error(r.error||'操作失败');return r;}
window.HospitalAdmin={api,call,esc,dialLink,modal,form,input,select,bindSave,toast,pager,close,logout,clearLogin,getUser:()=>currentUser,setUser,reload:load,reloadPatients:()=>{state.patients=1;if(active==='patients')load();},uuid};
$('loginForm').onsubmit=async e=>{e.preventDefault();$('btnLogin').disabled=true;$('pwdErr').textContent='';try{const r=await call('login',{username:$('usernameInput').value,password:$('pwdInput').value});token=r.token;setUser(r.user);sessionStorage.setItem('hospital_admin_token',token);$('pwdInput').value='';showApp();}catch(err){$('pwdErr').textContent=err.message;}finally{$('btnLogin').disabled=false;}};
$('btnLogout').onclick=$('mobileLogout').onclick=logout;
function setUser(user){currentUser=user;$('accountNav').hidden=user.role!=='admin';$('currentUserLabel').innerHTML=esc(user.display_name)+'<small>'+esc(user.role==='admin'?'管理员':'医护')+'</small>';}
function showApp(){$('loginMask').style.display='none';$('adminShell').style.display='flex';navigate();}
function go(page){if(location.hash==='#'+page)navigate();else location.hash=page;}
function navigate(){active=pages[location.hash.slice(1)]?location.hash.slice(1):'prenatal_overview';if(active==='accounts'&&currentUser?.role!=='admin')active='prenatal_overview';Object.keys(pages).forEach(p=>$('page-'+p).hidden=p!==active);document.querySelectorAll('[data-page]').forEach(a=>{a.classList.toggle('active',a.dataset.page===active);if(a.dataset.page===active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});$('currentPageTitle').textContent=pages[active];load();if(active==='tasks')departments().catch(e=>toast(e.message));}
window.addEventListener('hashchange',()=>{if(token)navigate();});
function status(t){return t.status==='pending'&&t.due_date<PatientData.today()?pill('overdue','已逾期'):pill(t.status);}
function isDemoRecord(value){return PatientData.isDemoRecord(value);}
function dialLink(phone,label='一键拨号',record=null){return PatientData.dialLink(phone,label,record,esc);}
function identity(p){return '<div class="customer-identity"><span class="customer-avatar">'+esc(p.name.slice(0,1))+'</span><div><strong>'+esc(p.name)+'</strong><small>'+esc(p.patient_no)+(isDemoRecord(p)?' · 演示勿拨':'')+'</small></div></div>';}
function pager(id,r,key){$(id).innerHTML='<span>共 '+r.total+' 条 · 第 '+r.page+' / '+Math.max(1,Math.ceil(r.total/20))+' 页</span><div><button class="btn-sm gray" data-pagekey="'+key+'" data-delta="-1" '+(r.page<=1?'disabled':'')+'>上一页</button><button class="btn-sm gray" data-pagekey="'+key+'" data-delta="1" '+(r.page*20>=r.total?'disabled':'')+'>下一页</button></div>';}
function recordHtml(r,withPatient=true){return '<article class="record-item"><div class="record-top"><strong>'+esc(withPatient?r.name:r.title)+'</strong>'+(withPatient?'<span class="muted">'+esc(r.patient_no||r.title)+'</span>':'')+pill(r.contact)+pill(r.condition)+'<time>'+when(r.created_at)+'</time></div><p>'+esc(r.notes)+'</p><div class="record-meta">'+esc(r.operator)+' · '+esc(labels[r.medication])+' · '+esc(labels[r.appointment])+(r.next_date?' · 再次联系 '+esc(r.next_date):'')+'</div></article>';}
async function departments(){const r=await call('patient_list',{page:1});const el=$('taskDepartment'),value=el.value;el.replaceChildren(new Option('全部科室',''),...r.departments.map(d=>new Option(d,d)));el.value=value;}
async function load(){if(!token)return;const n=++version;$('pageError').hidden=true;
try{
 if(active==='calling'){await window.CallingUI.load();return;}
 if(active.startsWith('prenatal_')){await window.PrenatalUI.load(active);return;}
 if(active==='accounts'){await window.AccountUI.load();return;}
 if(active==='overview'){
  const r=await call('hospital_overview');if(n!==version)return;const t=r.totals;
  $('overviewCards').innerHTML=[['在管患者',t.patients,'patients','','完整患者档案'],['今日待办',t.today,'tasks','today','待完成 '+t.pending+' 项'],['逾期随访',t.overdue,'tasks','overdue','需要优先安排联系'],['已完成随访',t.completed,'tasks','completed','已登记联系结果']].map(([name,num,page,filter,sub],i)=>'<button class="card stat-action '+(i===2?'alert':'')+'" data-go="'+page+'" data-filter="'+filter+'"><div class="k">'+name+'</div><div class="v">'+num+'<small>'+sub+'</small></div></button>').join('');
  state.tasksList=r.due;$('dueTasks').innerHTML=r.due.length?r.due.map(t=>'<div class="due-item"><div class="due-date">'+esc(t.due_date.slice(5))+'</div><div><strong>'+esc(t.name)+' '+status(t)+'</strong><p>'+esc(t.title)+' · '+esc(t.assigned_to)+'</p></div><button class="text-link" data-record="'+t.id+'">登记随访</button></div>').join(''):empty('暂无待办随访<br>添加患者并制定计划，开启连续照护。');
  const max=Math.max(1,...r.departments.map(d=>d.total));$('departmentBars').innerHTML=r.departments.length?r.departments.map(d=>'<div class="department-row"><div><span>'+esc(d.department)+'</span><b>'+d.total+'</b></div><span><i style="width:'+Math.round(d.total/max*100)+'%"></i></span></div>').join(''):empty('暂无科室待办数据','hospital');
  $('recentRecords').innerHTML=r.recent.length?r.recent.map(r=>recordHtml(r)).join(''):empty('完成一次随访后，记录将在这里呈现。','sheet');
 }else if(active==='patients'){
  const r=await call('patient_list',{keyword:$('patientSearch').value,department:$('departmentFilter').value,page:state.patients});if(n!==version)return;
  $('patientStats').innerHTML='<span><b>'+r.summary.total+'</b> 位患者</span><span><b>'+r.summary.discharged+'</b> 份出院档案</span><span><b>'+r.summary.departments+'</b> 个科室</span>';
  const selected=$('departmentFilter').value;$('departmentFilter').replaceChildren(new Option('全部科室',''),...r.departments.map(d=>new Option(d,d)));$('departmentFilter').value=selected;
  $('patientRows').innerHTML=r.list.map(p=>'<tr><td>'+identity(p)+'</td><td>'+esc(p.phone)+'<small class="cell-sub">'+dialLink(p.phone,'一键拨号',p)+'</small></td><td>'+esc(p.department||'未填写')+'<small class="cell-sub">'+esc(p.clinician||'未分配医护')+'</small></td><td>'+esc(p.discharge_date||'—')+'</td><td>'+(p.tags?p.tags.split(/[,，、;]/).filter(Boolean).map(t=>'<span class="customer-tag">'+esc(t)+'</span>').join(' '):'—')+'</td><td><div class="row-actions"><button class="text-link" data-detail="'+p.id+'">查看档案</button><button class="text-link" data-plan="'+p.id+'">制定计划</button></div></td></tr>').join('');
  $('patientEmpty').hidden=!!r.list.length;$('patientEmpty').querySelector('h3').textContent=$('patientSearch').value||selected?'没有找到匹配的患者':'建立第一份患者档案';pager('patientPager',r,'patients');
 }else if(active==='tasks'){
  const r=await call('followup_list',{keyword:$('taskSearch').value,department:$('taskDepartment').value,status:state.status,page:state.tasks});if(n!==version)return;state.tasksList=r.list;
  document.querySelectorAll('[data-status]').forEach(b=>b.classList.toggle('active',b.dataset.status===state.status));
  $('taskRows').innerHTML=r.list.map(t=>'<tr><td>'+identity(t)+'<small class="cell-sub">'+dialLink(t.phone,'一键拨号',t)+'</small></td><td>'+esc(t.title)+'<small class="cell-sub">'+esc(labels[t.channel])+' · '+esc(t.department||'未填写科室')+'</small></td><td class="nowrap">'+esc(t.due_date)+'</td><td>'+esc(t.assigned_to)+'</td><td>'+status(t)+'</td><td><div class="row-actions">'+(t.status==='pending'?'<button class="text-link" data-record="'+t.id+'">登记随访</button>':'')+'<button class="text-link" data-detail="'+t.patient_id+'">档案</button></div></td></tr>').join('');$('taskEmpty').hidden=!!r.list.length;pager('taskPager',r,'tasks');
 }else{
  const r=await call('followup_records',{keyword:$('recordSearch').value,condition:$('conditionFilter').value,page:state.records});if(n!==version)return;$('recordList').innerHTML=r.list.length?r.list.map(r=>recordHtml(r)).join(''):empty('暂无符合条件的随访记录。','sheet');pager('recordPager',r,'records');
 }
 renderIcons();
}catch(e){if(n===version){$('pageError').textContent=e.message;$('pageError').hidden=false;}}
}
[['patientSearchForm','patients'],['taskSearchForm','tasks'],['recordSearchForm','records']].forEach(([id,key])=>$(id).onsubmit=e=>{e.preventDefault();state[key]=1;load();});
[['departmentFilter','patients'],['taskDepartment','tasks'],['conditionFilter','records']].forEach(([id,key])=>$(id).onchange=()=>{state[key]=1;load();});
document.addEventListener('click',async e=>{
 const b=e.target.closest('button[data-go],button[data-pagekey],button[data-status],button[data-detail],button[data-plan],button[data-record],button[data-edit]');if(!b)return;
 if(b.dataset.go){if(b.dataset.filter){state.status=b.dataset.filter;state.tasks=1;}go(b.dataset.go);return;}
 if(b.dataset.pagekey==='accounts'){window.AccountUI.page(Number(b.dataset.delta));return;}
 if(b.dataset.pagekey){state[b.dataset.pagekey]+=Number(b.dataset.delta);load();return;}
 if(b.dataset.status){state.status=b.dataset.status;state.tasks=1;load();return;}
 try{b.disabled=true;if(b.dataset.detail)await detail(b.dataset.detail);if(b.dataset.edit)await editPatient(b.dataset.edit);if(b.dataset.plan)await plan(b.dataset.plan);if(b.dataset.record){const task=state.tasksList.find(t=>String(t.id)===b.dataset.record);if(task)record(task);}}catch(err){toast(err.message);}finally{b.disabled=false;}
});
function modal(title,html){modalVersion++;$('careTitle').textContent=title;$('careBody').innerHTML=html;if(!$('careDialog').open)$('careDialog').showModal();renderIcons($('careDialog'));return modalVersion;}
function close(){if(modalBusy)return;modalVersion++;$('careDialog').close();}
$('closeCare').onclick=close;$('careDialog').addEventListener('cancel',e=>{if(modalBusy)e.preventDefault();else modalVersion++;});
function input(key,label,value='',type='text',required=false,max=120,full=false){return '<label class="form-field '+(full?'full':'')+'"><span>'+label+(required?' <b>*</b>':'')+'</span><input name="'+key+'" type="'+type+'" value="'+esc(value)+'" '+(required?'required':'')+' maxlength="'+max+'"></label>';}
function select(key,label,options,value){return '<label class="form-field"><span>'+label+'</span><select name="'+key+'">'+options.map(([v,n])=>'<option value="'+v+'" '+(v===value?'selected':'')+'>'+n+'</option>').join('')+'</select></label>';}
function textarea(key,label,value='',max=1000,required=false){return '<label class="form-field full"><span>'+label+(required?' <b>*</b>':'')+'</span><textarea name="'+key+'" maxlength="'+max+'" '+(required?'required':'')+'>'+esc(value)+'</textarea></label>';}
function form(html,button='保存'){return '<form id="careForm"><div class="form-grid">'+html+'</div><div class="notice error form-error" id="formError" role="alert" hidden></div><div class="form-actions"><button class="btn secondary" type="button" id="cancelForm">取消</button><button class="btn" id="saveForm">'+button+'</button></div></form>';}
function bindSave(action,build,onDone){let requestId=uuid();$('cancelForm').onclick=close;$('careForm').addEventListener('input',()=>{requestId=uuid();});$('careForm').addEventListener('change',()=>{requestId=uuid();});$('careForm').onsubmit=async e=>{
 e.preventDefault();if(modalBusy)return;$('formError').hidden=true;const data=Object.fromEntries(new FormData(e.target));modalBusy=true;$('closeCare').disabled=true;const controls=[...e.target.elements];const disabled=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);
 try{const payload=build(data);const r=await call(action,{...payload,requestId});if(r.invalid)throw Error(r.errors.map(x=>x.errors.join('；')).join('；'));if(r.skipped)throw Error('该病案号已存在，请在患者档案中编辑');modalBusy=false;close();toast(onDone?onDone(r):'已保存');load();}
 catch(err){if($('careDialog').open&&$('formError')){$('formError').textContent=err.message;$('formError').hidden=false;}}
 finally{modalBusy=false;$('closeCare').disabled=false;controls.forEach((c,i)=>c.disabled=disabled[i]);}
 };}
async function editPatient(id){const p=id?(await call('patient_detail',{id})).patient:{};modal(id?'编辑患者档案':'新增患者档案',form(PatientData.fields.map(f=>{
 if(f.key==='sex')return select('sex','性别',[['','未填写'],['男','男'],['女','女'],['未知','未知']],p.sex||'');
 if(f.key==='notes')return textarea(f.key,f.label,p[f.key]||'',f.max);
 return input(f.key,f.label,p[f.key]||'',f.key.endsWith('_date')?'date':f.key==='phone'?'tel':'text',f.required,f.max,f.key==='diagnosis');
}).join('')+'<p class="form-hint full">病案号为患者唯一标识；同一家属联系电话可以关联多位患者。联系电话填写 11 位中国大陆手机号。</p>','保存档案'));
 $('careForm').querySelectorAll('input[type=date]').forEach(el=>el.max=PatientData.today());
 bindSave('patient_save',patient=>({id,patient}),()=>'患者档案已保存');}
$('newPatient').onclick=()=>editPatient().catch(e=>toast(e.message));
async function detail(id){const r=await call('patient_detail',{id}),p=r.patient;
 modal('患者档案','<div class="patient-profile"><span class="customer-avatar">'+esc(p.name.slice(0,1))+'</span><div><h3>'+esc(p.name)+'</h3><p>病案号 '+esc(p.patient_no)+' · '+esc(p.sex)+'</p></div></div><div class="detail-grid">'+PatientData.fields.filter(f=>!['name','patient_no','sex'].includes(f.key)).map(f=>'<div><span>'+f.label+'</span>'+esc(p[f.key]||'未填写')+'</div>').join('')+'</div><div class="detail-actions">'+dialLink(p.phone,'一键拨号',p)+'<button class="btn secondary" data-edit="'+p.id+'">编辑档案</button><button class="btn" data-plan="'+p.id+'">制定随访计划</button></div><h3 class="detail-heading">随访计划 · 最近 100 项</h3>'+(r.tasks.length?r.tasks.map(t=>'<div class="due-item"><div class="due-date">'+esc(t.due_date)+'</div><div><strong>'+esc(t.title)+'</strong><p>'+esc(t.assigned_to)+' · '+esc(labels[t.channel])+'</p></div>'+status(t)+'</div>').join(''):empty('尚未制定随访计划'))+'<h3 class="detail-heading">随访记录 · 最近 100 条</h3>'+(r.records.length?r.records.map(r=>recordHtml(r,false)).join(''):empty('尚无随访记录','sheet')));
}
async function plan(id){
 if(!id){const stamp=modal('选择随访患者','<form id="pickForm" class="patient-picker"><input id="pickSearch" aria-label="搜索需要随访的患者" placeholder="输入姓名或病案号"><button class="btn secondary">搜索</button></form><p class="form-hint">显示前 20 位患者；可输入病案号精确查找。</p><div id="pickResults"></div>');let seq=0;const search=async()=>{const n=++seq;try{const r=await call('patient_list',{keyword:$('pickSearch').value});if(stamp!==modalVersion||n!==seq)return;$('pickResults').innerHTML=r.list.length?r.list.map(p=>'<button class="patient-option" data-plan="'+p.id+'">'+esc(p.name)+' · '+esc(p.patient_no)+' · '+esc(p.department||'未填写科室')+'</button>').join(''):empty('未找到患者，请先在患者档案中建档。','users');}catch(e){if(stamp===modalVersion)$('pickResults').textContent=e.message;}};$('pickForm').onsubmit=e=>{e.preventDefault();search();};await search();return;}
 const p=(await call('patient_detail',{id})).patient;
 modal('制定随访计划','<div class="plan-patient">'+esc(p.name)+' · '+esc(p.patient_no)+'<small class="cell-sub">出院日期：'+esc(p.discharge_date||'未填写')+'</small></div>'+form(input('title','随访名称','出院随访','text',true)+input('assignedTo','责任医护',p.clinician,'text',true,80)+select('channel','随访方式',[['phone','电话随访'],['clinic','门诊随访'],['online','线上随访']],'phone')+select('mode','计划方式',[['single','指定日期 · 单次随访'],['schedule','按出院天数 · 多次随访']],'single')+input('dueDate','随访日期',PatientData.today(),'date',true)+input('offsets','出院后天数（用逗号分隔）','3,7,30')+'<p class="form-hint full" id="schedulePreview">单次随访按指定日期生成一项待办。</p>'+textarea('focus','随访重点','恢复情况、用药执行情况、复诊安排')+'<p class="form-hint full">计划生成后由责任医护执行并登记结果。日期早于今天的节点会显示为逾期待办。</p>','创建计划'));
 const f=$('careForm'),mode=f.elements.mode;const update=()=>{const schedule=mode.value==='schedule';f.elements.offsets.closest('label').hidden=!schedule;f.elements.offsets.disabled=!schedule;f.elements.dueDate.closest('label').hidden=schedule;f.elements.dueDate.disabled=schedule;const days=f.elements.offsets.value.split(/[,，\s]+/).filter(Boolean).map(Number);$('schedulePreview').textContent=!schedule?'单次随访按指定日期生成一项待办。':!p.discharge_date?'请先编辑患者档案，填写出院日期。':days.length&&days.every(n=>Number.isInteger(n)&&n>=0&&n<=365)?'预计日期：'+[...new Set(days)].sort((a,b)=>a-b).map(n=>new Date(Date.parse(p.discharge_date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10)).join('、'):'请输入 0–365 天的整数，最多 12 个节点。';};mode.onchange=f.elements.offsets.oninput=update;update();
 bindSave('followup_create',d=>({...d,patientId:p.id,offsets:(d.offsets||'').split(/[,，\s]+/).filter(Boolean).map(Number)}),r=>'已创建 '+r.created+' 项随访任务');
}
$('createPlan').onclick=()=>plan().catch(e=>toast(e.message));
function record(t){modal('登记随访结果','<div class="plan-patient">'+esc(t.name)+' · '+esc(t.patient_no)+'<small class="cell-sub">'+esc(t.title)+' · '+esc(t.due_date)+' · '+esc(labels[t.channel])+'</small><small class="cell-sub">联系电话：'+esc(t.phone)+'</small>'+(t.focus?'<p class="form-hint">随访重点：'+esc(t.focus)+'</p>':'')+'</div>'+form(input('operator','记录人',currentUser.display_name,'text',true,80)+select('contact','联系结果',[['reached','已联系'],['unreachable','未接通 · 重新安排'],['declined','拒绝随访 · 结束任务'],['cancelled','取消任务']],'reached')+select('condition','健康反馈',[['unknown','未评估'],['stable','恢复平稳'],['attention','需医护关注'],['urgent','已建议紧急就医']],'unknown')+select('medication','用药执行',[['unknown','未评估'],['as_directed','按医嘱用药'],['issue','用药有问题'],['not_applicable','无相关用药']],'unknown')+select('appointment','复诊安排',[['unknown','未评估'],['scheduled','已安排复诊'],['needed','待安排复诊'],['not_needed','暂不需复诊']],'unknown')+input('nextDate','再次随访日期（选填）','','date')+textarea('notes','随访记录与处理说明','',2000,true)+'<p class="form-hint full" id="recordHint">请填写实际联系情况与患者反馈。健康状态由记录人判断，系统不自动诊断。</p>','保存随访记录'));
 const f=$('careForm');f.elements.operator.readOnly=true;f.elements.nextDate.min=PatientData.today();f.elements.nextDate.max='2100-12-31';
 f.elements.contact.onchange=()=>{const contact=f.elements.contact.value;['condition','medication','appointment'].forEach(k=>{f.elements[k].disabled=contact!=='reached';if(contact!=='reached')f.elements[k].value='unknown';});f.elements.nextDate.disabled=['cancelled','declined'].includes(contact);f.elements.nextDate.required=contact==='unreachable';if(f.elements.nextDate.disabled)f.elements.nextDate.value='';$('recordHint').textContent=contact==='unreachable'?'未接通不会完成任务，请填写再次联系日期。':contact==='declined'?'记录患者拒绝随访的情况后，本次任务将结束。':contact==='cancelled'?'请在记录中说明取消原因。':'请填写实际联系情况与患者反馈。如选择再次随访日期，将另建一项待办。';};
 bindSave('followup_record',d=>({...d,taskId:t.id,condition:d.condition||'unknown',medication:d.medication||'unknown',appointment:d.appointment||'unknown'}),()=>'随访记录已保存');
}
document.addEventListener('DOMContentLoaded',()=>{if(token){call('session').then(r=>{setUser(r.user);showApp();}).catch(e=>{$('pwdErr').textContent=e.message;});}});
})();
