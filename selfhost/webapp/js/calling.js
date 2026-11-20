(function(){
'use strict';
const H=window.HospitalAdmin,D=window.PrenatalData,E=H.esc,$=id=>document.getElementById(id);
let epoch=0,session=null,revision=0,busy=false,starting=false,recorder=null,stream=null,chunks=[],audio=null,audioContext=null,timer=null,animation=null,listening=false,lastPayload=null,lastReply=null,playbackVersion=0,playbackTimer=null,startPayload=null,requestController=null;
let voiceReady=false,previewVersion=0,previewController=null,previewAudio=null,previewTimer=null,previewState='idle';
const page=$('page-calling');
page.innerHTML='<div class="page-heading"><div><div class="eyebrow">OUR FOLLOW-UP AGENT</div><h1>电话与语音随访</h1><p>本中心自研的随访机器人，听懂回答、记住上下文，追问尚未核实的信息。</p></div></div><div class="calling-capabilities"><article class="panel robot-card"><span class="pill active" id="robotStatus">正在检查</span><h2>自研 AI 随访机器人</h2><p>用自己的话回答，机器人根据上下文追问遗漏信息，按随访项目整理原文草稿。</p><p class="muted">支持语音与文字。先用虚拟信息试玩，再由医护评估话术和记录。</p><button class="btn" id="openRehearsal">开始机器人试玩</button></article><article class="panel"><span class="pill active">可使用</span><h2>一键拨号</h2><p>在患者档案、孕次档案或任务列表点击“一键拨号”，打开设备上的电话应用。</p><p class="muted">手机可进入拨号界面；电脑需要电话应用。联系结果由医护登记。</p><button class="btn secondary" data-call-go="patients">查看联系电话</button></article><article class="panel"><span class="pill overdue" id="callingLineStatus">正在检查</span><h2>接入患者手机</h2><p>自研机器人可以通过电话网关连接医院号码。机器人对话与电话线路分别建设。</p><button class="btn secondary" id="realDialButton" disabled>尚未接入电话线路</button><p class="muted" id="callingLineReason">正在查询服务状态…</p></article></div><div class="panel calling-recommendation"><div class="panel-heading"><h2>机器人自己做，线路按需接入</h2><span class="badge-soft">自研方案</span></div><p>当前已复用语言模型、语音识别和语音合成服务，由本系统管理随访流程、上下文与草稿。无需先购买第三方成品机器人。</p><ol><li><strong>现在：网页语音试玩。</strong>选择随访节点，使用文字或麦克风对话，查看机器人如何追问和整理记录。</li><li><strong>下一步：接入医院电话。</strong>向运营商或线路服务商申请支持医疗随访的 SIP 线路，通过 Asterisk / FreeSWITCH 等电话网关连接自研机器人。</li><li><strong>联调后：开通电话随访。</strong>用本中心测试号码验证外呼、未接通、拒访停止、转人工和结果回传，再安排实际随访。</li></ol><p class="muted">自研部分包括业务程序与对话编排；基础模型及语音服务仍需要服务器资源或接口费用。电话线路、号码与通话费用另计。</p></div>';
document.body.insertAdjacentHTML('beforeend','<dialog id="rehearsalDialog" class="import-dialog rehearsal-dialog" aria-labelledby="rehearsalTitle"><div class="import-header"><div><div class="eyebrow">OUR AGENT · WEB TRIAL</div><h2 id="rehearsalTitle">自研随访机器人试玩</h2></div><button class="icon-button" id="closeRehearsal" aria-label="结束并关闭演练">×</button></div><div class="rehearsal-body"><div class="prenatal-note">请扮演受访者，使用虚拟信息。智能模式会理解上下文并追问；所有草稿仍需人工核实。网页试玩不会拨打电话或保存到患者档案。</div><div class="form-grid" id="rehearsalSetup">'+H.select('rehearsalEngine','对话模式',[['ai','智能对话 · 自研机器人'],['scripted','标准问卷 · 固定流程']],'ai')+H.select('rehearsalStage','随访节点',D.stages.map(s=>[s.code,s.name]),'notification')+H.input('rehearsalCount','胎数（1–6）',1,'number',true)+'<fieldset class="rehearsal-voice full" id="rehearsalVoiceSettings" hidden><legend>声音与语速</legend><p class="form-hint">先听一小段，选择会用于本次试玩的全部播报。</p><div class="rehearsal-voice-fields">'+H.select('rehearsalVoice','音色',[],'')+H.select('rehearsalVoiceSpeed','语速',[],'')+'</div><blockquote id="rehearsalVoiceSample"></blockquote><div class="rehearsal-voice-actions"><button class="btn secondary" type="button" id="previewRehearsalVoice">试听这段话</button><span id="rehearsalVoiceStatus" role="status" aria-live="polite"></span></div></fieldset><button class="btn full" type="button" id="startRehearsal">开始 · 播放开场白</button><p class="form-hint full" id="rehearsalConnecting" role="status" hidden></p><button class="btn secondary full" type="button" id="cancelRehearsalStart" hidden>取消连接 · 重新选择</button></div><div id="rehearsalConversation" hidden><div class="rehearsal-status"><span class="pill active" id="rehearsalState" role="status">准备中</span><span class="muted" id="rehearsalProgress"></span></div><div class="robot-engine-row"><span id="robotEngineLabel"></span><span id="robotWarning" role="status"></span></div><div id="rehearsalHistory" class="rehearsal-history" role="log" aria-label="演练对话" aria-live="polite"></div><div class="rehearsal-playback"><button class="text-link" id="replayQuestion">重播提问</button><label><input type="checkbox" id="autoRehearsal"> 连续录音（播报后自动听下一句）</label></div><form id="rehearsalForm"><label class="form-field"><span>模拟受访者回答</span><textarea id="rehearsalAnswer" maxlength="1000" rows="2" placeholder="输入虚拟回答，或点击录音"></textarea></label><div class="rehearsal-actions"><button class="btn secondary" id="rehearsalMic" type="button">录音回答</button><button class="btn" id="sendRehearsal">发送文字回答</button><button class="btn secondary" id="retryRehearsal" type="button" hidden>重试本次回答</button></div><p class="form-hint">录音最长20秒；连续录音会在检测到说话后的停顿时提交。点击“停止录音并发送”可手动提交。</p></form><details id="robotDraft" class="robot-draft" hidden><summary id="robotDraftTitle">随访草稿</summary><div id="robotDraftBody"></div></details><div id="rehearsalSummary" hidden></div><div class="form-actions"><button class="btn secondary" id="restartRehearsal">重新选择节点</button></div></div><div id="rehearsalError" class="notice error" role="alert" hidden></div></div></dialog>');
const dialog=$('rehearsalDialog'),stage=document.querySelector('[name=rehearsalStage]'),count=document.querySelector('[name=rehearsalCount]'),engine=document.querySelector('[name=rehearsalEngine]');count.min='1';count.max='6';
const voiceSelect=document.querySelector('[name=rehearsalVoice]'),speedSelect=document.querySelector('[name=rehearsalVoiceSpeed]');
function voiceControls(){
 const locked=busy||!!startPayload||!voiceReady;
 voiceSelect.disabled=speedSelect.disabled=locked;
 const button=$('previewRehearsalVoice');button.disabled=locked;
 button.textContent=previewState==='loading'?'取消试听':previewState==='playing'?'停止试听':'试听这段话';
}
function stopPreview(message=''){
 previewVersion++;previewController?.abort();previewController=null;clearTimeout(previewTimer);previewTimer=null;
 if(previewAudio){previewAudio.onended=previewAudio.onerror=null;previewAudio.pause();previewAudio.removeAttribute('src');previewAudio.load();previewAudio=null;}
 previewState='idle';$('rehearsalVoiceStatus').textContent=message;voiceControls();
}
function configureVoices(settings){
 if(session||startPayload||busy)return;stopPreview();
 voiceReady=!!settings?.voices?.length&&!!settings?.speeds?.length;$('rehearsalVoiceSettings').hidden=!voiceReady;
 if(voiceReady){
  voiceSelect.replaceChildren(...settings.voices.map(v=>new Option(v.label,v.id)));
  speedSelect.replaceChildren(...settings.speeds.map(v=>new Option(v.label,v.id)));
  voiceSelect.value=settings.default.id;speedSelect.value=settings.default.speed;
  $('rehearsalVoiceSample').textContent=settings.sampleText;
 }
 voiceControls();
}
async function previewVoice(){
 if(busy||startPayload||!voiceReady)return;
 if(previewState!=='idle'){stopPreview('试听已停止');return;}
 stopPreview();const version=previewVersion,controller=new AbortController();previewController=controller;previewState='loading';voiceControls();
 $('rehearsalVoiceStatus').textContent='正在准备试听…';
 try{
  const r=await H.call('calling_voice_preview',{voice:{id:voiceSelect.value,speed:speedSelect.value}},{signal:controller.signal,timeoutMs:30000});
  if(version!==previewVersion||!dialog.open)return;
  if(!r.audio)throw Error('试听暂不可用，请稍后重试。');
  previewController=null;previewAudio=new Audio('data:audio/mpeg;base64,'+r.audio);
  previewState='playing';voiceControls();$('rehearsalVoiceStatus').textContent='正在试听 · '+r.voice.label;
  previewAudio.onended=()=>{if(version===previewVersion)stopPreview('试听结束，可以更换声音比较。');};
  previewAudio.onerror=()=>{if(version===previewVersion)stopPreview('音频播放失败，请重新试听。');};
  previewTimer=setTimeout(()=>{if(version===previewVersion)stopPreview('试听已停止，请重新试听。');},60000);
  await previewAudio.play();
 }catch(e){if(version===previewVersion&&dialog.open)stopPreview(e.name==='NotAllowedError'?'浏览器阻止了播放，请再次点击试听。':e.message||'试听暂不可用，请稍后重试。');}
}
$('previewRehearsalVoice').onclick=previewVoice;
voiceSelect.onchange=speedSelect.onchange=()=>stopPreview('设置已更换，点击试听比较。');
function error(text){$('rehearsalError').textContent=text||'';$('rehearsalError').hidden=!text;}
function renderDeferred(items){return items.length?'<h3>留待医护核对 · 暂不追问</h3>'+items.map(x=>'<div class="rehearsal-answer"><strong>'+E(x.question)+'</strong><p>'+E(x.reason)+'</p><p>'+E(x.evidence)+'</p><span class="pill overdue">尚未核实</span></div>').join(''):'';}
function status(text){$('rehearsalState').textContent=text;}
function connecting(text){$('rehearsalConnecting').textContent=text||'';$('rehearsalConnecting').hidden=!text;}
function controls(){voiceControls();const ended=lastReply?.done||false,pending=!!lastPayload;$('startRehearsal').disabled=busy;$('startRehearsal').textContent=busy?'正在连接…':startPayload?'重试 · 播放开场白':'开始 · 播放开场白';$('cancelRehearsalStart').hidden=!startPayload;stage.disabled=count.disabled=engine.disabled=busy||!!startPayload;$('sendRehearsal').disabled=busy||pending||listening||starting||ended;$('rehearsalAnswer').disabled=busy||pending||listening||starting||ended;$('rehearsalMic').disabled=busy||pending||starting||ended;$('rehearsalMic').textContent=listening?'停止录音并发送':starting?'正在打开麦克风…':'录音回答';$('replayQuestion').disabled=busy||pending||listening||starting||!lastReply?.audio;$('autoRehearsal').disabled=ended||pending;}
// Retry only these idempotent rehearsal requests; clinical writes use the normal API.
async function request(action,payload,n,timeoutMs,onRetry){
 const controller=new AbortController();requestController=controller;
 try{for(let attempt=0;attempt<2;attempt++){
  if(n!==epoch||!dialog.open)throw Error('请求已取消');
  try{return await H.call(action,payload,{timeoutMs,signal:controller.signal});}catch(e){
   if(n!==epoch||!dialog.open||!e.retryable||attempt===1||navigator.onLine===false)throw e;
   onRetry();await new Promise(resolve=>{const finish=()=>{clearTimeout(wait);controller.signal.removeEventListener('abort',finish);resolve();},wait=setTimeout(finish,900);controller.signal.addEventListener('abort',finish,{once:true});if(controller.signal.aborted)finish();});
  }
 }}finally{if(requestController===controller)requestController=null;}
}
function releaseMic(){clearTimeout(timer);timer=null;if(animation)cancelAnimationFrame(animation);animation=null;if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}if(audioContext){audioContext.close().catch(()=>{});audioContext=null;}listening=false;starting=false;}
function silence(){playbackVersion++;clearTimeout(playbackTimer);playbackTimer=null;if(audio){audio.onended=audio.onerror=null;audio.pause();audio.removeAttribute('src');audio.load();audio=null;}}
function stop(){stopPreview();epoch++;requestController?.abort();requestController=null;silence();if(recorder){recorder.ondataavailable=recorder.onstop=null;if(recorder.state!=='inactive')recorder.stop();recorder=null;}releaseMic();const id=session,requestId=startPayload?.requestId;session=null;lastReply=null;lastPayload=null;startPayload=null;revision=0;busy=false;connecting('');$('autoRehearsal').checked=false;if(id||requestId)H.api('calling_end',id?{id}:{requestId},{timeoutMs:10000}).catch(()=>{});$('rehearsalHistory').replaceChildren();$('rehearsalSummary').replaceChildren();$('robotDraftBody').replaceChildren();$('robotDraft').hidden=true;$('robotDraft').open=false;$('robotWarning').textContent='';$('rehearsalAnswer').value='';controls();}
function close(){stop();dialog.close();}
function reset(){stop();$('rehearsalSetup').hidden=false;$('rehearsalConversation').hidden=true;$('rehearsalSummary').hidden=true;$('retryRehearsal').hidden=true;$('rehearsalForm').hidden=false;error('');}
function open(stageCode='notification',fetuses=1){H.close();reset();stage.value=D.getStage(stageCode)?stageCode:'notification';count.value=fetuses;dialog.showModal();}
function render(r){
 lastReply=r;revision=r.revision;
 $('rehearsalHistory').innerHTML=r.history.map(m=>'<div class="rehearsal-message '+(m.role==='user'?'respondent':'assistant')+'"><strong>'+(m.role==='user'?'模拟受访者':r.dialogueMode==='ai'?'随访机器人':'语音助手')+'</strong><p>'+E(m.text)+'</p></div>').join('');
 $('rehearsalHistory').scrollTop=$('rehearsalHistory').scrollHeight;const deferred=r.draft?.deferred||r.deferred||[];$('rehearsalProgress').textContent='已收集 '+r.progress+' / '+r.total+' 项'+(deferred.length?' · '+deferred.length+' 项留待核对':'');
 $('robotEngineLabel').textContent=r.dialogueMode==='ai'?(r.engine==='ai'?'AI 理解与追问':r.engine==='fallback'?'智能理解暂不可用':'流程确认'):'标准问卷';
 $('robotWarning').textContent=r.aiWarning||'';
 if(r.voice)$('robotEngineLabel').textContent+=' · '+r.voice.label;
 if(r.draft){
  $('robotDraft').hidden=false;$('robotDraftTitle').textContent='随访草稿 · '+r.answers.length+' 项原文 · 待人工核实';
  $('robotDraftBody').innerHTML='<p class="form-hint">AI 按字段整理受访者原文，不能代替医护核实。</p>'+r.answers.map(a=>'<div class="rehearsal-answer"><strong>'+E(a.question)+'</strong><p>'+E(a.answer)+'</p><span class="pill overdue">'+(a.corrected?'含更正 · 待核实':a.uncertain?'不确定 · 待核实':a.complete?'已收集 · 待核实':'待补充 · 待核实')+'</span></div>').join('')+renderDeferred(deferred)+(r.draft.review.length?'<h3>需要医护关注</h3>'+r.draft.review.map(x=>'<div class="rehearsal-answer"><strong>'+E(x.reason)+'</strong><p>'+E(x.evidence)+'</p></div>').join(''):'')+(r.draft.pending.length?'<p class="form-hint">尚未收集完整：'+r.draft.pending.map(x=>E(x.question)).join('；')+'</p>':'');
 }
 if(r.done){
  $('autoRehearsal').checked=false;$('rehearsalForm').hidden=true;status('试玩结束');const labels={collected:'回答已收集 · 待医护核实',declined:'已结束询问',needs_review:'待人工核实',urgent:'需人工优先核实'};
  $('rehearsalSummary').hidden=false;$('rehearsalSummary').innerHTML='<h3>'+E(labels[r.outcome]||'试玩已结束')+'</h3><p class="form-hint">以下为模拟回答，不表示真实患者情况，也不代表随访任务已完成。</p>'+(!r.draft?r.answers.map(a=>'<div class="rehearsal-answer"><strong>'+E(a.question)+'</strong><p>'+E(a.answer)+(a.unverified?' <span class="pill overdue">未核实</span>':'')+'</p></div>').join('')+renderDeferred(deferred):'');
  if(r.draft)$('robotDraft').open=true;
 }else status('等待回答');controls();
}
async function play(r,n){silence();if(n!==epoch)return;if(!r.audio){$('autoRehearsal').checked=false;error(r.audioError||'语音暂不可用，请阅读文字。');status(r.done?'演练结束':'等待文字回答');return;}
 const playback=playbackVersion;audio=new Audio('data:audio/mpeg;base64,'+r.audio);status('正在播报');const next=()=>{clearTimeout(playbackTimer);if(n!==epoch||playback!==playbackVersion)return;status(r.done?'演练结束':'等待回答');if(!r.done&&$('autoRehearsal').checked)startMic().catch(e=>{error(e.message);$('autoRehearsal').checked=false;});};audio.onended=next;audio.onerror=()=>{if(n!==epoch||playback!==playbackVersion)return;$('autoRehearsal').checked=false;error('音频播放失败，可点击重播或使用文字回答。');};playbackTimer=setTimeout(()=>{if(n!==epoch||playback!==playbackVersion)return;silence();$('autoRehearsal').checked=false;error('播报超时，已停止连续录音。请手动继续。');},120000);
 try{await audio.play();}catch{if(n!==epoch||playback!==playbackVersion)return;clearTimeout(playbackTimer);$('autoRehearsal').checked=false;status('等待回答');error('浏览器未自动播放，请点击“重播提问”或直接回答。');}}
async function start(){
 if(busy||!count.reportValidity())return;stopPreview();const n=++epoch;
 if(!startPayload)startPayload={stage:stage.value,count:Number(count.value),engine:engine.value,requestId:H.uuid(),...(voiceReady?{voice:{id:voiceSelect.value,speed:speedSelect.value}}:{})};
 busy=true;controls();error('');connecting('正在连接随访服务，准备开场白…');
 try{const r=await request('calling_start',startPayload,n,30000,()=>connecting('连接暂时中断，正在自动重试（1/1）…'));
  if(n!==epoch||!dialog.open){H.api('calling_end',{id:r.id},{timeoutMs:10000}).catch(()=>{});return;}
  session=r.id;startPayload=null;connecting('');$('rehearsalSetup').hidden=true;$('rehearsalConversation').hidden=false;busy=false;render(r);await play(r,n);
 }catch(e){if(n===epoch){error(e.message);connecting('本次启动已保留，点击重试可继续；也可以重新选择设置。');}}
 finally{if(n===epoch){busy=false;controls();}}
}
async function submit(data,retry=false){if(busy||!session||lastReply?.done)return;const n=epoch;silence();error('');busy=true;controls();status(data.audio?'识别与处理回答…':'处理回答…');if(!retry)lastPayload={...data,id:session,revision,requestId:H.uuid()};$('retryRehearsal').hidden=true;
 try{const r=await request('calling_turn',lastPayload,n,110000,()=>status('连接暂时中断，正在恢复本次回答…'));if(n!==epoch||!dialog.open)return;lastPayload=null;$('rehearsalAnswer').value='';busy=false;render(r);await play(r,n);}catch(e){if(n===epoch){$('autoRehearsal').checked=false;error(e.message);status('本次回答未确认，请重试或重新开始');$('retryRehearsal').hidden=false;}}finally{if(n===epoch){busy=false;controls();}}}
async function startMic(){if(busy||listening||starting||lastReply?.done||!session)return;if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){$('autoRehearsal').checked=false;throw Error('当前浏览器不支持录音，请用HTTPS下的Chrome/Edge，或使用文字回答。');}silence();const n=epoch;starting=true;controls();error('');
 try{const media=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});if(n!==epoch||!dialog.open){media.getTracks().forEach(t=>t.stop());return;}stream=media;chunks=[];const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(x=>MediaRecorder.isTypeSupported(x));recorder=new MediaRecorder(media,mime?{mimeType:mime}:{});const rec=recorder;rec.ondataavailable=e=>{if(n===epoch&&e.data.size)chunks.push(e.data);};rec.onstop=async()=>{const blob=new Blob(chunks,{type:rec.mimeType});releaseMic();recorder=null;if(n!==epoch||!dialog.open)return;busy=true;controls();if(!blob.size){busy=false;controls();error('未录到声音，请重试');return;}if(blob.size>3*1024*1024){busy=false;controls();error('录音过大，请缩短回答');return;}try{const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(Error('读取录音失败'));reader.readAsDataURL(blob);});if(n===epoch){busy=false;await submit({audio:base64});}}catch(e){if(n===epoch){busy=false;controls();error(e.message);}}};rec.start();starting=false;listening=true;controls();status('正在录音，请说话');timer=setTimeout(()=>finishMic(),20000);
  // A slightly shorter silence threshold makes hands-free turns feel more conversational.
  if($('autoRehearsal').checked&&(window.AudioContext||window.webkitAudioContext)){audioContext=new(window.AudioContext||window.webkitAudioContext)();await audioContext.resume();if(n!==epoch||!listening)return;const analyser=audioContext.createAnalyser();analyser.fftSize=2048;audioContext.createMediaStreamSource(media).connect(analyser);const data=new Uint8Array(analyser.fftSize),started=performance.now();let heard=false,lastSound=started;function check(){if(n!==epoch||!listening)return;analyser.getByteTimeDomainData(data);const rms=Math.sqrt(data.reduce((sum,v)=>sum+((v-128)/128)**2,0)/data.length),now=performance.now();if(rms>0.025){heard=true;lastSound=now;}if(heard&&now-started>700&&now-lastSound>550){finishMic();return;}animation=requestAnimationFrame(check);}check();}
 }catch(e){if(n===epoch){if(recorder&&recorder.state!=='inactive'){recorder.onstop=null;recorder.stop();recorder=null;}releaseMic();$('autoRehearsal').checked=false;status('等待回答');controls();throw Error(e.name==='NotAllowedError'?'麦克风未获授权，可允许录音或改用文字。':e.message||'无法打开麦克风');}}}
function finishMic(){if(recorder&&recorder.state==='recording'){status('正在提交录音…');recorder.stop();clearTimeout(timer);timer=null;}}
$('openRehearsal').onclick=()=>open();$('startRehearsal').onclick=start;$('cancelRehearsalStart').onclick=reset;$('closeRehearsal').onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.addEventListener('close',()=>{stopPreview();if(session||startPayload||busy||stream||starting)stop();});$('restartRehearsal').onclick=reset;
$('rehearsalForm').onsubmit=e=>{e.preventDefault();const answer=$('rehearsalAnswer').value.trim();if(answer)submit({answer});};$('rehearsalMic').onclick=()=>{if(listening)finishMic();else startMic().catch(e=>error(e.message));};$('replayQuestion').onclick=()=>{if(lastReply)play(lastReply,epoch);};$('retryRehearsal').onclick=()=>{if(lastPayload)submit(lastPayload,true);};$('autoRehearsal').onchange=()=>{if(!$('autoRehearsal').checked&&listening)finishMic();};
document.querySelectorAll('[data-call-go]').forEach(b=>b.onclick=()=>location.hash=b.dataset.callGo);window.addEventListener('hashchange',()=>{if(dialog.open)close();});window.addEventListener('pagehide',stop);
document.addEventListener('click',e=>{if(e.target.closest('a.dial-link'))H.toast('已请求打开电话应用；接通情况请在通话后登记。');});
async function load(){const r=await H.call('calling_status');configureVoices(r.voiceSettings);$('callingLineStatus').textContent=r.automaticDial?'授权号码试拨':'待接入线路';$('callingLineReason').textContent=r.reason;$('realDialButton').disabled=!r.automaticDial;$('robotStatus').textContent=r.aiConfigured?'可试玩':'模型待配置';window.TelephoneUI?.state(r);await window.TelephoneUI?.load();}
window.CallingUI={load,open,stop};
})();
