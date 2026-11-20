(function(){
 'use strict';
 const $=id=>document.getElementById(id),A=window.HospitalAdmin;
 const {esc,call,modal,form,input,select,bindSave,toast}=A;
 let page=1,version=0,rows=[];
 const date=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'尚未登录';
 async function load(){
  const n=++version;const r=await call('account_list',{page,keyword:$('accountSearch').value,role:$('accountRole').value,status:$('accountStatus').value});
  if(n!==version||A.getUser()?.role!=='admin')return;
  rows=r.list;
  $('accountStats').innerHTML='<span><b>'+r.summary.total+'</b> 个账号</span><span><b>'+r.summary.enabled+'</b> 个启用账号</span><span><b>'+r.summary.admins+'</b> 位管理员</span>';
  $('accountRows').innerHTML=r.list.map(u=>{const self=String(u.id)===String(A.getUser().id);return '<tr><td><div class="customer-identity"><span class="customer-avatar">'+esc(u.display_name.slice(0,1))+'</span><div><strong>'+esc(u.display_name)+'</strong>'+(self?' <span class="pill">我</span>':'')+'<small>'+esc(u.username)+'</small></div></div></td><td>'+esc(u.department||'—')+'</td><td><span class="pill '+(u.role==='admin'?'completed':'')+'">'+(u.role==='admin'?'管理员':'医护')+'</span></td><td><span class="pill '+(u.enabled?'pending':'')+'">'+(u.enabled?'启用':'停用')+'</span></td><td class="nowrap">'+date(u.last_login_at)+'</td><td><div class="row-actions"><button class="text-link" data-account-edit="'+u.id+'">编辑</button>'+(self?'<button class="text-link" data-own-password>修改密码</button>':'<button class="text-link" data-account-reset="'+u.id+'">重置密码</button><button class="text-link '+(u.enabled?'danger-link':'')+'" data-account-status="'+u.id+'">'+(u.enabled?'停用':'启用')+'</button>')+'</div></td></tr>';}).join('');
  $('accountEmpty').hidden=!!rows.length;A.pager('accountPager',r,'accounts');
 }
 window.AccountUI={load,page:delta=>{page+=delta;A.reload();}};
 $('accountSearchForm').onsubmit=e=>{e.preventDefault();page=1;A.reload();};
 $('accountRole').onchange=$('accountStatus').onchange=()=>{page=1;A.reload();};
 function confirmPassword(d){if(d.password!==d.confirmPassword)throw Error('两次输入的密码不一致');if(d.password.length<8||d.password.length>128)throw Error('密码须为 8–128 位');}
 const passwordFields=()=>input('password','新密码','','password',true,128)+input('confirmPassword','确认新密码','','password',true,128)+'<p class="form-hint full">密码须为 8–128 位。请通过团队约定的方式告知账号使用人。</p>';
 function passwordHints(){const f=$('careForm');['password','confirmPassword'].forEach(k=>{f.elements[k].minLength=8;f.elements[k].autocomplete='new-password';});}
 function edit(u){
  const self=u&&String(u.id)===String(A.getUser().id);
  modal(u?'编辑账号':'新增账号',form(input('username','登录账号',u?.username||'','text',true,40)+input('displayName','姓名',u?.display_name||'','text',true,80)+input('department','科室',u?.department||'','text',false,80)+select('role','角色',[['staff','医护'],['admin','管理员']],u?.role||'staff')+(!u?passwordFields():'')+'<p class="form-hint full">医护可使用全部患者和随访功能，管理员还可维护团队账号。科室不限制数据访问范围。'+(u?'登录账号创建后不可更改。':'登录账号支持 3–40 位字母、数字、点、横线和下划线，不区分大小写。')+'</p>',u?'保存修改':'创建账号'));
  const f=$('careForm');f.elements.username.autocomplete='off';if(u)f.elements.username.readOnly=true;if(self)f.elements.role.disabled=true;if(!u)passwordHints();
  bindSave('account_save',d=>{if(!u)confirmPassword(d);return {...d,id:u?.id,role:self?u.role:d.role};},r=>{if(self)A.setUser(r.user);return u?'账号资料已更新':'账号已创建';});
 }
 $('newAccount').onclick=()=>edit();
 function reset(u){
  modal('重置账号密码','<div class="plan-patient">'+esc(u.display_name)+' · '+esc(u.username)+'</div>'+form(passwordFields()+'<p class="form-hint full">重置后，该账号的所有已登录会话立即失效，需要使用新密码重新登录。</p>','确认重置'));
  passwordHints();bindSave('account_reset',d=>{confirmPassword(d);return {id:u.id,password:d.password};},()=>'密码已重置，旧登录已失效');
 }
 function status(u){
  modal(u.enabled?'停用账号':'启用账号','<div class="plan-patient">'+esc(u.display_name)+' · '+esc(u.username)+'</div>'+form('<p class="form-hint full">'+(u.enabled?'停用后，该成员将立即退出登录，无法继续访问工作台。已创建的患者资料和随访记录保留。':'启用后，该成员可以使用原账号密码重新登录。')+'</p>',u.enabled?'确认停用':'确认启用'));
  bindSave('account_status',()=>({id:u.id,enabled:!u.enabled}),()=>u.enabled?'账号已停用':'账号已启用');
 }
 function changeMyPassword(){
  modal('修改我的密码',form(input('currentPassword','原密码','','password',true,128,true)+passwordFields().replace('请通过团队约定的方式告知账号使用人。','修改后需要重新登录，其他设备上的登录也会失效。'),'修改并重新登录'));
  passwordHints();$('careForm').elements.currentPassword.autocomplete='current-password';
  bindSave('password_change',d=>{confirmPassword(d);return d;},()=>{A.clearLogin();return '密码已修改，请使用新密码重新登录';});
 }
 $('changeMyPassword').onclick=changeMyPassword;
 document.addEventListener('click',e=>{
  const b=e.target.closest('[data-account-edit],[data-account-reset],[data-account-status],[data-own-password]');if(!b)return;
  if(b.hasAttribute('data-own-password')){changeMyPassword();return;}
  const u=rows.find(u=>String(u.id)===(b.dataset.accountEdit||b.dataset.accountReset||b.dataset.accountStatus));if(!u)return;
  if(b.dataset.accountEdit)edit(u);else if(b.dataset.accountReset)reset(u);else status(u);
 });
})();
