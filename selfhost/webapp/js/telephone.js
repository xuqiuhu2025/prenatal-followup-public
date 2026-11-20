(function(){
'use strict';
const H=window.HospitalAdmin,E=H.esc,$=id=>document.getElementById(id);
const labels={dialing:'正在呼叫',answered:'通话中',ended:'通话结束',busy:'忙线',no_answer:'未接听',failed:'拨号失败',interrupted:'通话中断',cancelled:'医护已停止',collected:'已收集 · 待核实',needs_review:'需医护跟进',urgent:'优先处理',declined:'本次未继续',callback_requested:'待确认回访时间',in_progress:'进行中'};
const reasons={controller_restarted:'服务重启中断',gateway_disconnected:'网关连接中断',originate_failed:'网关未确认拨号',ring_timeout:'振铃超时',dialogue_finished:'对话结束',remote_hangup:'对方挂断',media_closed:'音频连接关闭',silence_timeout:'长时间未收到回答',processing_failed:'语音处理失败',duration_limit:'达到最长通话时间',staff_stopped:'医护停止',opening_failed:'开场播报失败',tts_failed:'语音播报失败',dtmf_stop:'按键结束'};
let line=null,page=1,revision=0,poll=null,viewRevision=0;
Object.assign(reasons,{callback_requested:'受访者暂不方便，联系时间待医护确认',do_not_call:'对方要求停止或号码身份不符',asr_unclear:'未能听清回答',audio_backlog:'语音处理排队过长',unsupported_audio:'电话音频格式不支持',invalid_audio:'电话音频数据无效',long_answer:'回答过长，留待医护处理'});
const reasonLabel=value=>reasons[value]||(/^hangup_/.test(value)?'电话已挂断（原因码 '+value.slice(7)+'）':/^originate_/.test(value)?'网关结束呼叫（原因码 '+value.slice(10)+'）':value||'等待电话网关事件');
const when=x=>x?new Date(x).toLocaleString('zh-CN',{hour12:false}):'—';
const badge=x=>'<span class="pill '+(x==='urgent'?'overdue':'')+'">'+E(labels[x]||x)+'</span>';
$('page-calling').querySelector('.calling-recommendation').insertAdjacentHTML('beforebegin',[
'<section class="panel telephone-panel" aria-labelledby="phoneQueueTitle">',
'<div class="panel-heading"><div><span class="eyebrow">TELEPHONE PILOT</span><h2 id="phoneQueueTitle">通话与医护审核</h2></div><button class="btn secondary" id="refreshPhoneCalls">刷新记录</button></div>',
'<p class="form-hint">机器人收集回答，医护核对异常与后续安排。草稿审核和正式随访登记分别保存。</p>',
'<div id="phonePilotStatus" class="prenatal-note" role="status">正在检查电话服务…</div><div id="phoneListError" class="notice error" role="alert" hidden></div>',
'<div class="table-scroll"><table class="tbl"><thead><tr><th>通话 / 时间</th><th>号码</th><th>通话状态</th><th>审核状态</th><th>操作</th></tr></thead><tbody id="phoneCallRows"></tbody></table></div>',
'<div class="table-footer telephone-pager"><button class="text-link" id="phonePrev">上一页</button><span id="phonePageLabel"></span><button class="text-link" id="phoneNext">下一页</button></div></section>'
].join(''));
const card=$('realDialButton').closest('article');card.querySelector('h2').textContent='AI 电话随访试用';
card.querySelector('p').textContent='接通后自动问答，支持说话打断播报。通话结果进入医护审核列表。';
$('page-calling').querySelector('.calling-recommendation').innerHTML='<div class="panel-heading"><h2>先跑通产后随访，再扩展工作量</h2><span class="badge-soft">试用阶段</span></div><ol><li><strong>接入医院电话线路。</strong>需要 SIP 账号、医院主叫号码与授权试拨号码。</li><li><strong>小范围试拨。</strong>验证接通率、方言识别、插话和异常处理；当前每次由医护发起。</li><li><strong>核对记录。</strong>查看原话与草稿，重点处理异常、未答完和需要回访的情况，再登记正式随访结果。</li></ol><p class="muted">当前不提供实时人工转接、定时批量外呼或自动临床结论。对方要求人工时，会结束问答并进入待审核记录。</p>';
function state(r){line=r;$('realDialButton').disabled=!r.automaticDial;$('realDialButton').textContent=r.automaticDial?'发起电话试拨':'等待电话线路';$('callingLineStatus').textContent=r.automaticDial?'授权号码试拨':'等待接入';$('callingLineReason').textContent=r.reason;$('phonePilotStatus').textContent=r.reason+'。'+(r.callingHours?'拨打时段：'+r.callingHours+'。':'')+(r.allowedNumberCount?'已配置 '+r.allowedNumberCount+' 个测试号码。':'');}
async function load(){
 const current=++revision;clearTimeout(poll);
 try{const r=await H.call('calling_phone_list',{page});if(current!==revision||!H.getUser())return;$('phoneListError').hidden=true;
  $('phoneCallRows').innerHTML=r.list.length?r.list.map(c=>'<tr><td><strong>'+E(c.name||'授权测试通话')+'</strong><small class="cell-sub">'+E(c.title||'产后随访')+' · '+E(when(c.created_at))+'</small></td><td>'+E(c.phone)+'</td><td>'+badge(c.status)+(c.priority==='urgent'?badge('urgent'):'')+'</td><td>'+E(c.review_status==='reviewed'?'已审核':'待医护审核')+'</td><td><button class="text-link" data-phone-detail="'+E(c.id)+'">查看 / 审核</button></td></tr>').join(''):'<tr><td colspan="5"><div class="empty-state">暂无通话。线路接通后，可从上方发起授权号码试拨。</div></td></tr>';
  $('phonePageLabel').textContent='第 '+page+' 页';$('phonePrev').disabled=page===1;$('phoneNext').disabled=!r.more;
 }catch(e){if(current===revision){$('phoneListError').textContent=e.message;$('phoneListError').hidden=false;}}
 if(current===revision&&H.getUser()&&location.hash==='#calling')poll=setTimeout(async()=>{try{const r=await H.call('calling_status');if(current!==revision||!H.getUser())return;state(r);}catch{}if(current===revision)void load();},8000);
}
async function openDial(){
 const view=++viewRevision;const r=await H.call('calling_status');if(view!==viewRevision||!H.getUser())return;state(r);if(!line.automaticDial){H.toast(line.reason);return;}
 const tasks=await H.call('prenatal_tasks',{status:'pending',stage:'postnatal',page:1});
 if(view!==viewRevision||!H.getUser())return;
 const available=tasks.list.filter(t=>t.channel==='phone'&&!PatientData.isDemoRecord(t));
 H.modal('发起产后随访试拨',H.form(H.select('taskId','关联随访任务',[['','仅测试，不关联患者档案'],...available.map(t=>[E(t.id),E(t.name)+' · '+E(t.title)])],'')+H.input('phone','已授权测试手机号','','tel',true,11)+H.input('count','胎数',1,'number',true)+'<label class="telephone-consent full"><input type="checkbox" name="authorized" required><span>对方已同意参加机器人试拨；测试号码已由管理员加入允许清单。</span></label><p class="form-hint full">关联任务时使用档案中的号码和胎数，仅显示前20条待办中的电话任务。点击下方按钮会立即请求拨号。</p>','立即试拨'));
 const f=$('careForm'),phone=f.elements.phone,count=f.elements.count,task=f.elements.taskId;count.min='1';count.max='6';phone.pattern='1[3-9][0-9]{9}';
 task.onchange=()=>{const t=available.find(t=>String(t.id)===task.value);phone.disabled=!!t;count.disabled=!!t;phone.value=t?t.phone:'';count.value=t?t.fetus_count:1;};
 let requestId=H.uuid(),fingerprint='',sending=false;
 f.onsubmit=async event=>{event.preventDefault();if(sending||!f.reportValidity())return;const data={taskId:task.value||null,phone:phone.value.trim(),stage:'postnatal',count:Number(count.value),authorized:f.elements.authorized.checked};
  const key=JSON.stringify(data);if(fingerprint&&key!==fingerprint)requestId=H.uuid();fingerprint=key;sending=true;const button=$('saveForm');button.disabled=true;
  try{const r=await H.call('calling_dial',{...data,requestId},{timeoutMs:15000});if(view!==viewRevision||!H.getUser()||!$('careDialog').open||!f.isConnected)return;H.close();H.toast('拨号请求已受理，接通情况请查看通话状态。');await load();await detail(r.id);}
  catch(e){if(f.isConnected){$('formError').textContent=e.message+' 如连接中断，请先查看通话记录；原样重试不会重复发起。';$('formError').hidden=false;}}finally{sending=false;button.disabled=false;}
 };
}
async function detail(id){
 const view=++viewRevision,r=await H.call('calling_phone_detail',{id});if(view!==viewRevision||!H.getUser())return;
 const c=r.call,d=c.draft||{},active=['dialing','answered'].includes(c.status);
 const transcript=d.transcript||d.history||[];
 const replies=(d.answers||[]).map(a=>'<div class="rehearsal-answer"><strong>'+E(a.question||a.key)+'</strong><p>'+E(a.answer)+'</p><span class="muted">原话草稿 · 待核实</span></div>').join('');
 const review=[...(d.draft?.review||[]),...(d.draft?.deferred||[]),...(d.deferred||[])];
 const metrics=d.metrics||[],metricSummary=metrics.length?'<h3>语音响应时间</h3><p class="form-hint">'+metrics.map((m,i)=>'第 '+(i+1)+' 轮：识别 '+(m.asrMs/1000).toFixed(1)+' 秒 · 理解 '+(m.modelMs/1000).toFixed(1)+' 秒 · 合成 '+(m.ttsMs/1000).toFixed(1)+' 秒 · 完整响应 '+(m.toAudioMs/1000).toFixed(1)+' 秒').join('</p><p class="form-hint">')+'</p>':'';
 H.modal('通话记录 · '+(c.name||'授权测试'),'<div class="telephone-summary">'+badge(c.status)+badge(c.outcome)+'<p>'+E(c.phone)+' · '+E(when(c.created_at))+'</p><p class="form-hint">'+E(reasonLabel(c.reason))+'</p></div>'+(active?'<div class="rehearsal-actions"><button class="btn secondary" id="phoneDetailRefresh">刷新通话</button><button class="btn secondary" id="phoneStop">停止本次电话</button></div>':'')+
 metricSummary+
 '<h3>待核实草稿</h3>'+(replies||'<p class="form-hint">尚未收集到结构化回答，请查看通话原文。</p>')+
 (review.length?'<div class="prenatal-note">'+review.map(x=>'<p>'+E(x.reason)+'：'+E(x.evidence||'')+'</p>').join('')+'</div>':'')+
 '<details class="robot-draft"><summary>查看通话原文（语音识别可能有误）</summary>'+transcript.map(x=>'<div class="rehearsal-answer"><strong>'+E(x.role==='user'?'受访者':'机器人')+(x.delivery==='interrupted'?' · 播报被打断':'')+'</strong><p>'+E(x.text)+'</p></div>').join('')+'</details>'+
 (active?'<p class="form-hint">通话结束后可审核。关闭此窗口不会挂断电话。</p>':c.review_status==='reviewed'?'<div class="prenatal-note"><strong>已审核</strong><p>'+E(c.review_note)+'</p></div>':H.form('<label class="form-field full"><span>审核与后续处理说明</span><textarea name="note" rows="3" maxlength="2000" required placeholder="例如：已核对，宝宝检查结果需电话回访确认。"></textarea></label><p class="form-hint full">审核保存处理意见；正式临床结果仍需在随访任务中登记。</p>','保存审核'))+
 (c.task_id&&!active?'<div class="form-actions"><button class="btn secondary" id="phoneClinicalRecord">打开正式随访登记</button></div>':''));
 if(active){$('phoneDetailRefresh').onclick=()=>detail(id).catch(e=>H.toast(e.message));$('phoneStop').onclick=async()=>{try{await H.call('calling_phone_stop',{id});await detail(id);await load();}catch(e){H.toast(e.message);}};}
 if(!active&&c.review_status!=='reviewed')$('careForm').onsubmit=async event=>{event.preventDefault();const f=event.currentTarget,button=$('saveForm');button.disabled=true;try{await H.call('calling_phone_review',{id,note:f.elements.note.value});H.toast('审核意见已保存');await detail(id);await load();}catch(e){if(f.isConnected){$('formError').textContent=e.message;$('formError').hidden=false;}}finally{button.disabled=false;}};
 if($('phoneClinicalRecord'))$('phoneClinicalRecord').onclick=()=>{const raw=transcript.filter(x=>x.role==='user').map(x=>'受访者（语音识别草稿）: '+x.text).join('\n');H.close();window.PrenatalUI.record(c.task_id,raw).catch(e=>H.toast(e.message));};
}
$('realDialButton').onclick=()=>openDial().catch(e=>H.toast(e.message));$('refreshPhoneCalls').onclick=()=>{void load();};$('phonePrev').onclick=()=>{if(page>1)page--;void load();};$('phoneNext').onclick=()=>{page++;void load();};
$('phoneCallRows').onclick=e=>{const b=e.target.closest('[data-phone-detail]');if(b)detail(b.dataset.phoneDetail).catch(e=>H.toast(e.message));};
function stop(){revision++;viewRevision++;clearTimeout(poll);$('phoneCallRows').replaceChildren();}
window.addEventListener('hashchange',()=>{if(location.hash!=='#calling'){revision++;viewRevision++;clearTimeout(poll);}});window.addEventListener('pagehide',stop);
window.TelephoneUI={state,load,stop};
})();
