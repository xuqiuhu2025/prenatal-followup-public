'use strict';
const D=require('./followup-dialogue'),{split}=require('./telephone-speech');
// Only literals derived from empty, synthetic states can enter the shared cache.
// Replies containing a person's name, observations or clinical data are excluded.
const warm=[
  '稍等一下。',
  '这阵子您身体恢复得怎么样？',
  '妈妈这阵子身体恢复得怎么样？',
  '好，谢谢您。孩子出生后，后来情况怎么样？',
  '好，谢谢您。宝宝最近吃得、睡得怎么样？',
  '好，谢谢您。最近有带宝宝去做儿保吗？',
  '好，谢谢您。医生有没有交代接下来什么时候复查？',
  '好，谢谢您。宝宝出生时多重，您还记得吗？',
  '不记得也没关系。',
  '抱歉，我暂时无法准确整理您刚才的回答。',
  '您的原话会留给医护核对，今天先聊到这里。',
  '这通电话暂时不能转接医生或护士。',
  '您可以通过医院官方渠道联系中心。',
  '我先结束询问，并将希望医护联系的请求列入审核记录。'
];
const human='这通电话暂时不能转接医生或护士。您可以通过医院官方渠道联系中心。我先结束询问，并将希望医护联系的请求列入审核记录。';
warm.push(...split(human));
const fixed=new Set(warm);
for(const respondent of ['self','family']){
  const s=D.create('postnatal',1,{mode:'telephone'});s.respondent=respondent;
  for(const status of [undefined,'liveborn']){
    s.care.birthStatus[1]=status;
    for(const q of s.questions){const text=D.postnatalPrompt(s,q);for(const prefix of ['','好，谢谢您。','没关系，记不清的以后再核对。']){fixed.add(prefix+text);for(const part of split(prefix+text))fixed.add(part);}}
  }
}
module.exports={cacheable:text=>fixed.has(text),warm};
