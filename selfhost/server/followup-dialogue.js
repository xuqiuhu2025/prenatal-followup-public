'use strict';
// Staff rehearsal only. Answers are captured verbatim, never inferred as clinical facts.
const D=require('./prenatal-data');
const intro='您好，我是中心的AI随访助手。这是一次演练，请用虚构信息回答。请问您是本人，还是本人同意来回答的家属？';
const yes=/^(是|是的|我是本人|本人|我是家属|授权家属|是本人|是家属|可以|同意|方便|好的|好|愿意|有空|现在方便|嗯|对|是本人可以)[。！!，,\s]*$/;
const no=/不是|非本人|打错|不认识|未授权|没有授权|不方便|不同意|不愿意|拒绝|别打|不要打|不需要|没空|不想|停止|挂断|结束|再见/;
const unsure=/^(不知道|不清楚|不确定|没听清|听不清|不知道啊|忘了|记不清|不知道呢)[。！!，,\s]*$/;
const lossResponse='听到这个消息，我很遗憾。如果您愿意，我们可以再聊一点；不想说也没关系。';
const lossWords=/(?:没(?:有)?保住|没能保住|没留住|没能留住|没能留下来|宝宝没了|孩子没了|自然流产|发生流产|已经流产|死胎|死产|终止妊娠|未活产|没有活产)/;
function remembersNothing(t){return /不(?:知道|清楚|确定|记得)|记不(?:清|住)|忘(?:了|记)|没(?:看|拿到)|不在(?:手边|身边)|没有(?:带|记录|报告)/.test(t);}
function declinesDetails(t){return /不(?:想|愿意|愿|方便)(?:再)?(?:回忆|回顾)|不(?:想|愿意|愿|方便)(?:再)?(?:说|讲|提|回答)(?:这个|这项|这部分|这些|那部分|经过|细节|评分)|别(?:再)?问(?:经过|细节|这些)|不要(?:再)?问(?:经过|细节|这些)/.test(t)&&!/(?:不是|并非)不(?:想|愿意)/.test(t);}
function endsConversation(t){
 if(/不想(?:再)?(?:回答|说|聊)这(?:个|些)?部分|不想(?:回答|说|聊)这项/.test(t)&&!/不想(?:再)?继续/.test(t))return false;
 const stop=/^(?:不了|不用了|不愿意|不聊了|先不聊|今天先到这(?:里)?(?:吧)?)[。！!，,\s]*$|(?:结束|停止)(?:本次)?(?:通话|对话|随访|询问|演练|试玩)|挂断|不要再打|别打电话|不想(?:再)?(?:继续|聊)|不愿意继续|不想(?:再)?(?:说|回答)(?:了|下去)|拒绝(?:本次)?随访|别问了|(?:现在|这会儿|今天)(?:真的)?(?:不方便|没空)/g;
 return [...t.matchAll(stop)].some(m=>!/(?:不是|并非|并不|不等于|不代表|不想|不要|没有说).{0,2}$/.test(t.slice(0,m.index)));
}
function skipsDetailsOnly(t){return declinesDetails(t)&&!endsConversation(t);}
function isUnknownAnswer(t){return /^(?:(?:这(?:个|些)?|评分|报告)(?:我也?)?)?(?:不(?:知道|清楚|确定|记得)|记不清|忘了|报告不在(?:手边|身边)|没带报告|没拿到报告|没有报告|这个记不清)(?:了|啊|呢)?[。！!，,\s]*$/.test(t);}
function unavailableReport(t){return /(?:报告|记录|病历)(?:现在|暂时|目前)?(?:不在(?:手边|身边)|没带|没拿到|找不到|不方便看)|(?:不在(?:手边|身边)|没带|没拿到|找不到).{0,6}(?:报告|记录|病历)/.test(t);}
function isLossPermissionAnswer(t){return continuationYes(t)||endsConversation(t)||/不想(?:继续|聊)|不愿意(?:继续|聊)/.test(t);}
function continuationYes(t){return /^(?:好|好的|是|是的|可以(?:继续)?|愿意(?:继续)?|同意|嗯(?:，?可以)?|你问吧|您问吧|继续吧)[。！!，,\s]*$/.test(t);}
function familySelfHealth(s,t){const personal=/(?:我自己|我本人|我的身体|我身体|我恢复|我最近|我这阵子)/.test(t);return s.respondent==='family'&&personal&&!/(?:妈妈|产妇|她|妻子|老婆|爱人).{0,8}(?:恢复|身体|情况|还好|不错)|(?:恢复|身体|情况).{0,8}(?:妈妈|产妇|她|妻子|老婆|爱人)/.test(t);}
function postnatalCare(s){
 if(!s.care)s.care={};
 for(const key of ['birthStatus','birthEvidence','deferred','lossAcknowledged'])if(!s.care[key])s.care[key]={};
 return s.care;
}
function birthStatus(t){
 let previous=false,conditional=false,living=false,loss=false;
 for(const part of t.split(/[，。；！？,;!?\n]|但是|不过|但/)){
  if(/这次|本次|后来|最终|实际|事实上|现在|目前/.test(part)){previous=false;conditional=false;}
  if(/上次|上一胎|上个孩子|以前那次|前一次/.test(part))previous=true;
  if(/如果|假如|假设/.test(part))conditional=true;
  if(previous||conditional)continue;
  const m=lossWords.exec(part)||/(?:宝宝|孩子|婴儿).{0,12}(?:去世|离世)/.exec(part);
  if(m&&!/(?:没有|没发生|并未|不是|并非|不会|担心|害怕|如果|是否|会不会|风险|可能|避免).{0,12}$/.test(part.slice(0,m.index))&&!/(?:风险|可能性|担心|害怕|万一|如果|是否|会不会)/.test(part.slice(m.index+m[0].length,m.index+m[0].length+8))&&!/(?:没有|并未|不是|会不会|担心).{0,6}(?:去世|离世)/.test(m[0]))loss=true;
  if(!/如果|假如|假设|会不会|是否|担心|还没出生|没有出生|没出生/.test(part)&&(/(?:宝宝|孩子|婴儿|一宝|二宝|大宝|小宝).{0,14}(?:吃奶|喝奶|吃得|睡得|睡觉|发育|满月|出院)|(?:出生后|新生儿科|儿科).{0,20}(?:住|出院)|(?:宝宝|孩子|婴儿|一宝|二宝|大宝|小宝).{0,8}(?:现在|目前|已(?:经)?|满)[\d一二两三四五六七八九十]+(?:个?月|岁|天)|(?:是|为|属于)活产/.test(part))&&!/(?:不是|并非|不属于)活产/.test(part))living=true;
 }
 return loss?'loss_reported':living?'liveborn':null;
}
function fetusSpans(s,text){
 const markers=[...text.matchAll(/(?<![上前])(?:第([1-6一二三四五六])(?:胎|个宝宝|个孩子)|([1-6一二三四五六])宝|第([1-6一二三四五六])个|大宝|小宝|老大|老二)/g)];
 return markers.map((m,i)=>{const id=m[1]||m[2]||m[3],n=id?(/\d/.test(id)?Number(id):'一二三四五六'.indexOf(id)+1):/大宝|老大/.test(m[0])?1:2;return {n,start:m.index,end:markers[i+1]?.index??text.length,text:text.slice(m.index,markers[i+1]?.index??text.length)};}).filter(x=>x.n<=s.count);
}
function allBabies(t){return /(?:两个宝宝|两个孩子|俩宝宝|俩孩子|所有宝宝|宝宝们)(?:都|均)/.test(t);}
function matchesFetus(s,key,evidence,text){
 const n=Number(/^f([1-6])_/.exec(key)?.[1]);if(!n||s.count===1)return true;
 const spans=fetusSpans(s,text);
 if(spans.length){
  const hits=[];for(let at=text.indexOf(evidence);at!==-1;at=text.indexOf(evidence,at+1)){const span=spans.find(x=>at>=x.start&&at+evidence.length<=x.end);if(span)hits.push(span.n);}
  return hits.length>0&&hits.every(id=>id===n);
 }
 return allBabies(evidence)||Number(/^f([1-6])_/.exec(s.currentKey||'')?.[1])===n;
}
function validPostnatalEvidence(key,evidence){
 if(key==='maternal_recovery')return true;
 if(/^f[1-6]_birth$/.test(key))return /出生|生产|顺产|剖(?:宫)?产|足月|早产|活产|没保住|没能保住|没留住|没能留住|流产|死胎|死产|终止妊娠|孩子没了|宝宝没了|无胎心|未见胎心|孕\s*\d|孕周|超声.{0,12}(?:报告|检查|提示)|(?:19|20)\d{2}年?\d{1,2}月\d{1,2}[日号]|\d{1,2}月\d{1,2}[日号]|\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(evidence);
 if(/^f[1-6]_perinatal$/.test(key))return /(?:19|20)\d{2}年|\d+\s*\+\s*\d+\s*周|足月|早产|顺产|剖(?:宫)?产|身长|厘米|cm|体重|千克|公斤|kg|性别|男孩|女孩|^男[,，。]|^女[,，。]/i.test(evidence);
 if(/^f[1-6]_neonatal_course$/.test(key))return /新生儿科|儿科|NICU|住院|出院|听力|脚跟|足跟|筛查|遗传代谢|黄疸|早产|保温箱|采血/.test(evidence);
 if(/^f[1-6]_health$/.test(key))return /宝宝|孩子|婴儿|大宝|小宝|一宝|二宝|吃奶|喝奶|发育|儿保|医生|复查|体检/.test(evidence);
 if(/^f[1-6]_(?:confirmation|nonliveborn_review)$/.test(key))return /检查|超声|报告|医生|医院|孩子|宝宝|流产|死产|终止妊娠|没保住|孕\s*\d/.test(evidence);
 return true;
}
function captureChildHealth(s,text){
 if(s.stage!=='postnatal')return [];
 const candidates=[];
 if(s.count===1){const match=/(?:宝宝|孩子|婴儿).{0,100}/.exec(text);if(match)candidates.push({key:'f1_health',evidence:match[0].trim()});}
 else for(const span of fetusSpans(s,text))candidates.push({key:'f'+span.n+'_health',evidence:span.text.trim()});
 return candidates.filter(x=>x.evidence&&validPostnatalEvidence(x.key,x.evidence));
}
function outcomeStatus(evidence){
 if(/(?:终止妊娠|自然流产|流产|死胎|死产|未活产|没有活产|没(?:有)?保住|没能保住|宝宝没了|孩子没了)/.test(evidence))return 'nonliveborn';
 if(/(?:活产|活婴|(?:宝宝|孩子|婴儿|大宝|小宝|[一二]宝|第?[一二]胎).{0,24}(?:出生|出院)|(?:出生|出院).{0,16}(?:宝宝|孩子|婴儿|体重|新生儿科))/.test(evidence))return 'liveborn';
 return null;
}
function observeOutcomes(s,text,updates=[]){if(s.stage!=='outcome')return;for(const update of updates){const fetus=/^f([1-6])_outcome$/.exec(update?.key||'');if(!fetus||typeof update.evidence!=='string'||!text.includes(update.evidence.trim()))continue;const status=outcomeStatus(update.evidence.trim());if(status)(s.outcomeStatus||(s.outcomeStatus={}))[fetus[1]]=status;}}
function observePostnatal(s,text){
 if(s.stage!=='postnatal')return null;const care=postnatalCare(s),seen=new Map();
 if(s.count===1)seen.set(1,[text]);
 else{
  const spans=fetusSpans(s,text);for(const span of spans)seen.set(span.n,[...(seen.get(span.n)||[]),span.text]);
  if(!spans.length){const n=Number(/^f([1-6])_/.exec(s.currentKey||'')?.[1]);if(allBabies(text))for(let i=1;i<=s.count;i++)seen.set(i,[text]);else if(n)seen.set(n,[text]);}
 }
 let newLoss=null;for(const [n,quotes]of seen){const evidence=quotes.join('，'),status=birthStatus(evidence);if(!status)continue;
  if(care.birthStatus[n]==='loss_reported'&&status==='liveborn'&&!/更正|说错|刚才.*(?:不对|错了)/.test(text)){deferPostnatal(s,'f'+n+'_birth',text,'前后结局描述有差异，待医护对照原文核实');continue;}
  care.birthStatus[n]=status;care.birthEvidence[n]=evidence;for(const [key,d]of Object.entries(care.deferred))if(key.startsWith('f'+n+'_')&&d.blockedByBirth)delete care.deferred[key];if(status==='loss_reported'&&!care.lossAcknowledged[n]){care.lossAcknowledged[n]=true;newLoss??=n;}
 }return newLoss;
}
function activeQuestions(s){return s.questions.filter(q=>{
  if(s.stage==='outcome'&&q.appliesTo==='liveborn'){const n=/^f([1-6])_/.exec(q.key)?.[1];if(s.outcomeStatus?.[n]==='nonliveborn')return false;}
 if(s.stage!=='postnatal')return true;const care=postnatalCare(s);if(care.deferred[q.key])return false;const n=/^f([1-6])_/.exec(q.key)?.[1],status=n&&care.birthStatus[n];
 if(q.appliesTo==='nonliveborn')return status==='loss_reported';
 if(q.appliesTo==='liveborn')return status!=='loss_reported';
 return true;
});}
function deferPostnatal(s,key,evidence,reason='受访者暂不清楚，留待医护核对'){
 if(s.stage!=='postnatal'||!s.questions.some(q=>q.key===key))return;
 postnatalCare(s).deferred[key]={evidence,reason};
}
function deferUnknownBirth(s,key,evidence){const n=/^f([1-6])_birth$/.exec(key)?.[1];if(!n||postnatalCare(s).birthStatus[n])return;for(const q of s.questions.filter(q=>q.key.startsWith('f'+n+'_')&&q.key!==key))if(!postnatalCare(s).deferred[q.key])postnatalCare(s).deferred[q.key]={evidence,reason:'本宝宝结局尚未明确，相关随访内容待医护核对',blockedByBirth:true};}
function deferLossDetails(s,evidence){const care=postnatalCare(s);for(let n=1;n<=s.count;n++)if(care.birthStatus[n]==='loss_reported'){deferPostnatal(s,'f'+n+'_birth',evidence,'受访者不愿回顾，结局资料待医护另行核对');deferPostnatal(s,'f'+n+'_nonliveborn_review',evidence,'受访者不愿回顾，后续不追问经过');}}
function questionLabel(q){if(!q)return '';const labels={maternal_recovery:'产妇近期恢复',postnatal_support:'后续支持需要',birth:'出生或妊娠结局与日期',health:'孩子近况与评价来源',perinatal:'出生信息与评分',neonatal_course:'出生后住院与筛查',confirmation:'原检查目标的核实',nonliveborn_review:'结局资料与后续核实'},fetus=/^f([1-6])_(.+)$/.exec(q.key);return labels[q.key]||(fetus&&labels[fetus[2]]?'宝宝 '+fetus[1]+' · '+labels[fetus[2]]:q.prompt);}
function deferredItems(s){return s.stage==='postnatal'?Object.entries(postnatalCare(s).deferred).map(([key,d])=>({key,question:questionLabel(s.questions.find(q=>q.key===key)),...d})):[];}
function postnatalEvidence(s,q){const n=/^f([1-6])_/.exec(q.key)?.[1],prefix=n?'f'+n+'_':null,keys=s.questions.filter(x=>prefix?x.key.startsWith(prefix):x.key===q.key).map(x=>x.key);return [...keys.flatMap(key=>s.facts?.[key]?.quotes||s.answers.filter(a=>a.key===key).map(a=>a.answer)),...(n?[postnatalCare(s).birthEvidence[n]||'']:[])].join('，');}
function childEvidence(s,n){return ['health','perinatal','neonatal_course','birth'].flatMap(field=>s.facts?.['f'+n+'_'+field]?.quotes||s.answers.filter(a=>a.key==='f'+n+'_'+field).map(a=>a.answer)).concat(postnatalCare(s).birthEvidence[n]||'').join('，');}
function postnatalPrompt(s,q){
 if(s.stage!=='postnatal')return q.prompt;const care=postnatalCare(s),n=/^f([1-6])_/.exec(q.key)?.[1],status=n&&care.birthStatus[n],child=s.count===1?'宝宝':'第'+n+'个宝宝';
 const evidence=postnatalEvidence(s,q);
 const allEvidence=n?childEvidence(s,n):evidence;
 if(q.key==='maternal_recovery')return s.respondent==='family'?'妈妈这阵子身体恢复得怎么样？':'这阵子您身体恢复得怎么样？';
 if(q.key.endsWith('_birth')&&status==='liveborn')return (/(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]|\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(evidence)||/出生日期|出生时间|出生于/.test(allEvidence))?'出生日期我先记下了，记不准的话以后可以对照记录。':'宝宝是哪天出生的？记不清也没关系。';
 if(q.key.endsWith('_birth')&&status==='loss_reported')return '如果您方便，还记得大概是哪天的事吗？记不清可以以后核对。';
 if(q.key.endsWith('_health')&&status!=='liveborn')return '孩子出生后，后来情况怎么样？';
 if(q.key.endsWith('_health')){if(!/吃奶|喝奶|吃得|睡得|睡觉|精神|发育|健康|吃睡/.test(allEvidence))return child+'最近吃得、睡得怎么样？';if(!/医生|儿保|儿童保健|体检|复查/.test(allEvidence))return '最近有带'+child+'去做儿保吗？';if(!/下次|继续|预约|随访|复查|复诊/.test(allEvidence))return '医生有没有交代接下来什么时候复查？';return child+'最近还有什么情况，您想跟我们说的吗？';}
 if(q.key.endsWith('_perinatal')&&evidence)return child+'出生时多重，您还记得吗？不记得也没关系。';
 if(q.key.endsWith('_perinatal'))return child+'出生时多重，您还记得吗？不记得也没关系。';
 if(q.key.endsWith('_neonatal_course')&&evidence)return child+'出生后的检查，有哪些是做过并收到结果的？';
 if(q.key.endsWith('_neonatal_course'))return child+'出生后，有没有在新生儿科住过院？';
 if(q.key.endsWith('_confirmation'))return child+'出生后，医生有没有交代要继续复查什么？';
 return q.prompt;
}
function nextPostnatalQuestion(s,answeredKey,remaining){
  const ordered=remaining.filter(q=>q.key!==answeredKey);if(!ordered.length)return undefined;
 const n=/^f([1-6])_/.exec(answeredKey)?.[1],priority=answeredKey==='maternal_recovery'?['f1_birth','f1_health']:!n?['postnatal_support']:['f'+n+'_health','f'+n+'_perinatal','f'+n+'_neonatal_course','f'+n+'_confirmation','f'+n+'_birth','postnatal_support'];
 for(const key of priority){const q=ordered.find(x=>x.key===key);if(q)return q;}
  return ordered.find(q=>q.key==='postnatal_support')||ordered[0];
}
function urgent(t){
 const symptoms=/(?:大出血|大量出血|剧烈腹痛|呼吸困难|喘不过气|昏迷|意识不清|胎动(?:明显)?减少|胎动消失|无胎心|未见胎心)/;
 const parts=t.split(/[，。；！？,;!?\n]|但是|不过|但/);
 if(parts.some(part=>{
  const match=symptoms.exec(part);if(!match)return false;
  const before=part.slice(0,match.index),after=part.slice(match.index+match[0].length);
  const historical=/(?:以前|之前|此前|曾经|过去|当时|既往|孕\s*\d+(?:\+\d+)?|孕周|报告(?:中|写|提示|显示)|病历(?:中|记录|写)|超声(?:检查|报告|记录|提示|显示)|出院记录)/.test(before);
  const activeNow=/(?:现在|目前|此刻|正在|今天|刚刚|仍然|仍有|持续|又出现|还在)/.test(part);
  const denied=/(?:没有|并无|否认|未出现|已无|已经没有|完全没有|从未|目前没有|现在没有|目前.{0,8}(?:已处理|未再|缓解|恢复)|现在.{0,8}(?:已处理|未再|缓解|恢复))/.test(part);
  if(denied&&!activeNow)return false;
  if(historical&&!activeNow)return false;
  return true;
 }))return true;
 return /胎动(?:明显)?减少|胎动消失/.test(t)&&/(?:现在|目前|此刻|正在|今天|刚刚|仍然|仍有|持续|又出现|还在).{0,12}(?:仍然|仍有|明显|持续|继续)?(?:减少|消失)/.test(t);
}
function questions(stage,count=1){
 if(!D.getStage(stage))throw Error('随访节点无效');if(!Number.isInteger(count)||count<1||count>6)throw Error('胎数须为1至6');
 const q=[];const add=(key,prompt,instructions=prompt,appliesTo='all')=>q.push({key,prompt,instructions,appliesTo});
 if(['notification','report'].includes(stage)){
  add('notified',stage==='notification'?'您是否已收到本次筛查报告，并由医护告知结果？':'您是否已经收到本次诊断报告，并由医护解释结果？');
  add('counseling','是否已接受中心医师咨询？如已完成，请说出咨询日期和机构；未完成可说明预约或拒绝情况。');
  add('arrangement','医师安排的下一步检查或就诊是什么？有需要随访人员帮助联系的事项吗？');
 }else if(stage==='referral'){
  add('referral','是否已经到转诊机构就诊？请说明机构和到诊日期，未到诊也请如实说明。');
  add('diagnosis','是否完成医师安排的诊断检查？请说明已完成、已预约、待落实或拒绝，以及相应日期。');
  add('support','转诊或诊断安排还有什么需要医护协助的问题？');
 }else if(stage==='procedure'){
  add('procedure_date','请说明接受取材操作的日期和取材方式，例如羊膜腔穿刺。');
  add('procedure_event','操作后一周内有无不适、就诊或胎儿丢失情况？请按实际情况说明。');
  add('event_detail','如果有异常，请说明发生日期和医护处理情况；没有或不清楚也请如实说明。');
 }else if(stage==='outcome'){
  for(let i=1;i<=count;i++){
   add('f'+i+'_outcome','请说明第'+i+'胎的妊娠结局：仍在妊娠、活产、自然流产、死胎或死产、终止妊娠，或暂不清楚。');
   add('f'+i+'_date','第'+i+'胎如已结束妊娠，请说明实际日期；如尚未结束或不清楚，请直接说明。');
   add('f'+i+'_health','第'+i+'胎如为活产，请说明出生体重、是否有医生告知的出生缺陷；其他结局可说明不适用。','仅在本胎明确为活产后核实出生体重及医生是否告知出生缺陷；结局为非活产时此项不适用。','liveborn');
  }
 }else if(stage==='postnatal'){
  add('maternal_recovery','先问问您，这阵子身体恢复得怎么样？','了解产妇目前的身体恢复和不适；家属可转述产妇情况，不知道就保留未知，不把家属自己的情况当作产妇情况。');
  for(let i=1;i<=count;i++){
   const child=count===1?'宝宝':'第'+i+'个宝宝';
   add('f'+i+'_birth',count===1?'后来生产的情况，您方便简单说说吗？':'关于'+child+'，后来生产的情况您方便说说吗？','记录本胎妊娠结局及实际日期。已谈到孩子现在吃睡、出生后住院或出院时，只补问缺失的出生日期，不重复询问是否活产。未活产按明确自述或病历原文保留，不推定具体结局。');
   add('f'+i+'_health',child+'最近吃得、睡得怎么样？','了解本孩子准确月龄、家属观察到的健康和发育、医生是否评估及是否继续儿保/专科随访。每次只问一项，不能把家属说正常当作医生评估。','liveborn');
   add('f'+i+'_perinatal',child+'出生时的情况，您还记得哪些？记不清的以后看记录就好。','核实出生孕周、分娩方式、性别、身长、体重与单位、Apgar分值及明确评分时点。一次只追问一个缺项，先问家属能回忆的情况。评分时点等报告细节可待医护核实，不要求家属现在找报告或读完所有字段。','liveborn');
   add('f'+i+'_neonatal_course',child+'出生后，有没有在新生儿科住过院？','核实是否住新生儿科/儿科/重症监护、住院原因和天数、出院记录、听力及脚跟血遗传代谢筛查是否完成和报告结果。只追问尚未说到的一项；已提住院时，不再次询问是否住院；家属不清楚就保留待核实。','liveborn');
   add('f'+i+'_confirmation','孕期检查提到的那个问题，出生后医生有没有再帮忙核实？','仅核实原检查目标疾病有无正式诊断结论和医院、报告、日期。未提供孕期目标时不得编造疾病名；来源不足保留待核实，不能从外观或家属觉得正常推断排除疾病。','liveborn');
   add('f'+i+'_nonliveborn_review','如果您愿意，医生有没有跟您解释过这次的情况？','受访者愿意时再核实本胎结局的病历原文、孕周、日期及已实施的检查。仅说没保住不能推定为流产、死产或出生后死亡；须保留原话。不要求回忆经过，不推测原因，不追问未做检查的理由。资料不在身边或不愿回顾就待医护以后核对。','nonliveborn');
  }
  add('postnatal_support','眼下有没有什么事，您希望中心医护帮忙的？','收集受访者明确表达的联系、咨询或支持需要；只记录需要，不声称已联系或安排医护。');
 }else add('feedback','本次还有哪些情况需要向随访团队反馈或需要医护协助？');
 add('evidence',stage==='postnatal'?'刚才这些情况，是您自己记得的，还是看着出院记录说的？':'以上情况来自本人或家属回忆，还是病历、检查报告或医院反馈？请说明资料来源。','区分本人/家属回忆、正式病历报告、医院反馈和未知。不要要求现在翻找报告，也不要求复述已说过的内容。');
 add('next_contact',stage==='postnatal'?'要是后面还需要核对，什么时候联系您比较方便？':'若有事项需要继续核实，什么时间方便医护再次联系？');
 return q;
}
function opening(options={}){return options.mode==='telephone'?'您好，我是'+(options.center||'产前筛查与诊断中心')+'的AI随访助手。请问您是本人，还是经本人同意接听的家属？':intro;}
function phoneReply(s,text){
 if(s.mode!=='telephone')return text;
 if(text.includes('这是演练，您可以随时停下来'))return '现在方便聊几分钟，了解妈妈和宝宝的近况吗？回答会转成文字供中心医护核对，您随时可以结束。';
 if(text.includes('这是演练')||text.includes('这次是演练'))return '谢谢您告诉我这些。回答会整理成草稿，交由中心医护核对。今天先聊到这里，再见。';
 if(text.includes('筛查高风险不等于确诊'))return '报告解读和诊疗安排需要中心医师结合具体情况确认。我先把您的问题留给医护核对。';
 if(text.includes('这个问题得请医生结合检查来解释'))return '这个问题得请医生结合检查来解释，我这里不能下结论。我会把您的问题留给医护核对。';
 if(text.includes('本次试玩先结束，已在草稿'))return '好的，今天先聊到这里。您的问题会保留在待医护审核的记录中；这里暂时不能直接转接医生，有急事请联系医院。';
 if(text.includes('智能理解连续未能完成'))return '抱歉，这会儿没能听明白您的意思。我们先结束，已经说到的内容留给医护核对。';
 if(text.includes('智能理解暂时不可用'))return '抱歉，刚才没能听明白。您可以再简单说一遍吗？';
 return text.replaceAll('试玩草稿','随访草稿').replaceAll('演练草稿','随访草稿').replaceAll('演练结果','随访草稿');
}
function create(stage,count=1,options={}){return {stage,count,mode:options.mode||'rehearsal',phase:'identity',index:0,questions:questions(stage,count),answers:[],history:[{role:'assistant',text:opening(options)}],done:false,outcome:'in_progress',clarifications:0,...(stage==='outcome'?{outcomeStatus:{}}:{}),...(stage==='postnatal'?{care:{birthStatus:{},deferred:{},lossAcknowledged:{}}}:{})};}
function advance(s,text){
 if(s.done)throw Error('演练已结束，请重新开始');if(typeof text!=='string'||!text.trim()||text.length>1000)throw Error('请提供1–1000字回答');text=text.trim();s.history.push({role:'user',text});let reply;
 const end=(reason,message)=>{s.done=true;s.outcome=reason;return message;};
 if(urgent(text))reply=end('urgent','您提到可能需要立即评估的情况。如正在发生，请及时联系产科急诊；症状严重请拨打120。本次询问到此结束，演练结果标记为需要人工优先核实。');
 else if((no.test(text)&&(s.phase==='identity'||s.phase==='consent'||/挂断|停止|结束|再见|别打|不要打|不方便|没空|不想回答|不愿意继续|拒绝随访/.test(text))||endsConversation(text))&&!(s.phase==='questions'&&s.stage==='postnatal'&&skipsDetailsOnly(text)))reply=end('declined','好的，今天先聊到这里。需要时可以通过医院官方渠道联系中心。');
 else if(s.phase==='identity'||s.phase==='consent'){
  if(yes.test(text)){s.clarifications=0;if(s.phase==='identity'){s.respondent=/家属/.test(text)?'family':'self';s.phase='consent';reply='现在方便聊几句吗？不方便的话，我们就先到这里。';}else{s.phase='questions';reply=postnatalPrompt(s,s.questions[0]);}}
  else if(++s.clarifications>=2)reply=end('needs_review','暂未确认身份或是否方便继续，本次询问结束，留待人工核实。');
  else reply=s.phase==='identity'?'请明确回答：是本人或经授权家属，还是不是？未确认前不询问个人情况。':'请明确回答现在方便并同意继续，或不方便。';
 }else{
  const available=activeQuestions(s).filter(q=>!s.answers.some(a=>a.key===q.key)),q=available.find(q=>q.key===s.currentKey)||available[0];
  if(!q){reply=end('needs_review','今天先聊到这里，暂未明确的内容留待医护核对。');s.history.push({role:'assistant',text:reply});return {reply,done:s.done,outcome:s.outcome};}
  const care=s.stage==='postnatal'?postnatalCare(s):null;
  const newLoss=observePostnatal(s,text);
  if(newLoss){const key='f'+newLoss+'_birth',evidence=care.birthEvidence[newLoss];s.answers.push({key,question:questionLabel(s.questions.find(q=>q.key===key)),answer:evidence,unverified:true});deferPostnatal(s,key,evidence,'仅保留自述，具体结局与日期待医护核对');care.awaitingLossPermission=true;reply=lossResponse+'您愿意继续聊几句吗？';if(skipsDetailsOnly(text)){deferLossDetails(s,text);care.awaitingLossPermission=false;s.currentKey='postnatal_support';reply='听到这个消息，我很遗憾。我们先不问这些细节。眼下有什么事，您希望中心医护帮忙的？';}}
  else if(s.stage==='postnatal'&&skipsDetailsOnly(text)){const lossRefusal=care.awaitingLossPermission||q.key.endsWith('_nonliveborn_review')||(/_birth$/.test(q.key)&&care.birthStatus[/^f([1-6])/.exec(q.key)?.[1]]==='loss_reported')||(Object.values(care.birthStatus).includes('loss_reported')&&/回顾|回忆|经过|细节/.test(text));if(lossRefusal)deferLossDetails(s,text);deferPostnatal(s,q.key,text,'受访者不愿回答该项');deferUnknownBirth(s,q.key,text);care.awaitingLossPermission=false;const available=activeQuestions(s),next=(lossRefusal&&available.find(x=>x.key==='postnatal_support'&&!s.answers.some(a=>a.key===x.key)))||available.find(x=>!s.answers.some(a=>a.key===x.key));s.currentKey=next?.key;reply=next?'没关系，我们先不聊这部分。'+postnatalPrompt(s,next):end('needs_review','今天先聊到这里，暂未明确的内容留待医护核对。');}
  else if(care?.awaitingLossPermission){if(continuationYes(text)){care.awaitingLossPermission=false;s.currentKey='maternal_recovery';reply=postnatalPrompt(s,s.questions.find(x=>x.key==='maternal_recovery'));}else if(endsConversation(text)){care.awaitingLossPermission=false;reply=end('declined','好的，今天先聊到这里。需要时可以通过医院官方渠道联系中心。');}else{reply='可以只聊您愿意说的部分，也可以今天先到这里。您愿意继续吗？';}}
  else if(s.stage==='postnatal'&&familySelfHealth(s,text)){s.currentKey='maternal_recovery';reply='谢谢您，我想了解的是妈妈的恢复情况。她这阵子身体怎么样？';}
  else{
  // Questions about results must not be interpreted as an answer to the current field.
  if(/[?？]|什么意思|是不是确诊|怎么办|怎么回事|能不能|要不要|正常吗|严重吗/.test(text)){
   if(++s.clarifications>=2)reply=end('needs_review','您的问题需要医护进一步解释，本次询问结束，演练结果标记为待人工咨询。');
   else reply=s.stage==='postnatal'?'这个问题得请医生结合孩子的检查来看，我这里不能下结论。'+postnatalPrompt(s,q):'个人报告判读和诊疗安排请由中心医师确认；筛查高风险不等于确诊。我们先核实实际情况：'+q.prompt;
  }else{
   const unknown=s.stage==='postnatal'&&isUnknownAnswer(text);
   if(unknown){deferPostnatal(s,q.key,text);deferUnknownBirth(s,q.key,text);}
   s.answers.push({key:q.key,question:questionLabel(q),answer:text,unverified:s.stage==='postnatal'||unsure.test(text)});s.clarifications=0;
   const remaining=activeQuestions(s).filter(q=>!s.answers.some(a=>a.key===q.key)),next=s.stage==='postnatal'?nextPostnatalQuestion(s,q.key,remaining):remaining[0];
   if(next)s.currentKey=next.key;
   reply=next?(s.stage==='postnatal'?(remembersNothing(text)?'没关系，记不清的以后再核对。':'好，谢谢您。')+postnatalPrompt(s,next):'已记下您的回答。'+next.prompt):end(care&&Object.keys(care.deferred).length?'needs_review':'collected','谢谢您告诉我这些。这次是演练，内容只形成待医护核实的草稿，没有完成真实随访。');
  }
  }
  s.index=activeQuestions(s).filter(q=>s.answers.some(a=>a.key===q.key)).length;
 }
 reply=phoneReply(s,reply);s.history.push({role:'assistant',text:reply});return {reply,done:s.done,outcome:s.outcome};
}
function snapshot(s){const active=activeQuestions(s),progress=s.stage==='postnatal'?active.filter(q=>s.answers.some(a=>a.key===q.key)).length:s.index;return {stage:s.stage,count:s.count,done:s.done,outcome:s.outcome,progress,total:active.length,answers:s.answers,history:s.history,...(s.stage==='postnatal'?{deferred:deferredItems(s)}:{})};}
module.exports={intro,opening,phoneReply,questions,create,advance,snapshot,urgent,activeQuestions,observePostnatal,observeOutcomes,outcomeStatus,captureChildHealth,postnatalCare,postnatalPrompt,questionLabel,deferredItems,deferPostnatal,deferUnknownBirth,deferLossDetails,remembersNothing,isUnknownAnswer,unavailableReport,declinesDetails,skipsDetailsOnly,endsConversation,continuationYes,isLossPermissionAnswer,familySelfHealth,matchesFetus,validPostnatalEvidence,nextPostnatalQuestion,lossResponse};
