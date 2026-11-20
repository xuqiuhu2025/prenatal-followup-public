'use strict';

// Narrow, verbatim collection for unambiguous everyday answers. Everything else
// stays with the contextual agent. These are reports by the respondent, not diagnoses.
function extract(state,text){
  if(state.mode!=='telephone'||state.stage!=='postnatal'||state.count!==1||text.length>180)return null;
  if(/[?？]|但是|不过|其实|更正|说错|刚才|不知道|不清楚|不确定|可能|好像|应该|如果|以前|上次|上一胎|去年|担心|医生说|检查结果|报告|没保住/.test(text))return null;
  const parts=text.split(/[，,。.!！；;\n]|(?=(?:宝宝|孩子)(?:现在|目前|已经|吃奶|喝奶|吃睡|睡觉))/).map(x=>x.trim()).filter(Boolean),updates=[];
  let childContext=state.currentKey==='f1_health',childSeen=false;
  for(const part of parts){
    let key,complete=false;
    const maternal=/^(?:(妈妈|产妇|她|妻子|老婆|爱人|我)(?:现在|最近|这阵子)?(?:身体)?|(?:我)?(?:现在|最近|这阵子)?(?:身体)?)(?:恢复(?:得|的)?)?(?:还好|挺好|很好|不错|正常|还不错|还可以|挺好的)(?:啊|呀|呢|了)?$/;
    const mother=part.match(maternal);
    if(mother&&(mother[1]&&mother[1]!=='我'||state.currentKey==='maternal_recovery'&&state.respondent==='self'&&!childContext)){
      key='maternal_recovery';complete=true;
    }else{
      let rest=part;
      if(/^(?:宝宝|孩子)/.test(rest)){childContext=true;rest=rest.replace(/^(?:宝宝|孩子)/,'');}
      if(!childContext)return null;
      rest=rest.replace(/^(?:现在|目前|已经)/,'');
      const age=rest.match(/^[0-9一二两三四五六七八九十百]+(?:个?月|天|岁)(?:了)?/);
      if(age)rest=rest.slice(age[0].length);
      const wellbeing=/^(?:(?:吃奶|喝奶|吃饭)(?:和|、)?(?:睡觉|睡眠)?|吃睡|睡觉|精神)(?:都|也)?(?:挺好|还好|很好|正常|不错|挺好的|还不错)$/;
      const care=/^(?:最近)?(?:做过|做了|去做了|带去做了)(?:一次)?(?:儿保|儿童保健|体检)$/;
      if((age&&!rest)||wellbeing.test(rest)||care.test(rest)){
        key='f1_health';childSeen=true;
      }else return null;
    }
    if(state.facts[key]?.complete||state.facts[key]?.corrected)return null;
    updates.push({key,evidence:part,complete,uncertain:false,correction:false});
  }
  return updates.length?{updates,childSeen}:null;
}
module.exports={extract};
