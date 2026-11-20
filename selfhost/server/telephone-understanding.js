'use strict';
// One bounded hedge through the existing gateway. First valid result wins;
// cancellation propagates to both requests, and only the caller commits state.
function understand(chat,messages,options,valid,{hedgeMs=2200,totalMs=6000}={}){
  return new Promise(resolve=>{
    const controllers=[],timings=[];let started=0,completed=0,settled=false,hedge,deadline;
    const parent=options.signal;
    const finish=(value,winner)=>{if(settled)return;settled=true;clearTimeout(hedge);clearTimeout(deadline);parent?.removeEventListener('abort',cancel);
      for(const controller of controllers)controller.abort();
      options.onTiming?.({...timings[winner],attempts:started,hedged:started>1,...(winner===undefined?{failure:parent?.aborted?'cancelled':'deadline_or_invalid'}:{})});resolve(value);};
    const cancel=()=>finish(null);
    const attempt=()=>{
      if(settled||started>=2)return;const index=started++,controller=new AbortController();controllers.push(controller);
      Promise.resolve().then(()=>chat(messages,{...options,signal:controller.signal,timeoutMs:totalMs,onTiming:t=>{timings[index]=t;}})).then(raw=>{
        if(settled)return;completed++;if(valid(raw)){finish(raw,index);return;}
        if(started<2){clearTimeout(hedge);attempt();}else if(completed===started)finish(null);
      },()=>{if(settled)return;completed++;if(started<2){clearTimeout(hedge);attempt();}else if(completed===started)finish(null);});
    };
    if(parent?.aborted){finish(null);return;}parent?.addEventListener('abort',cancel,{once:true});
    deadline=setTimeout(()=>finish(null),totalMs);hedge=setTimeout(attempt,hedgeMs);attempt();
  });
}
module.exports={understand};
