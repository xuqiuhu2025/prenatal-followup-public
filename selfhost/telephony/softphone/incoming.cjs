#!/usr/local/bin/node
'use strict';
const readline=require('node:readline'),rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
const env={};let ready=false;
rl.on('line',async line=>{
 if(ready){if(line.startsWith('200'))process.exit(0);return;}
 if(line){const i=line.indexOf(':');if(i>0)env[line.slice(0,i)]=line.slice(i+1).trim();return;}
 ready=true;
 try{const params=new URLSearchParams({channel:env.agi_channel||'',mode:process.argv[2]||'inbound'});const r=await fetch('http://127.0.0.1:9095/incoming?'+params,{method:'POST',signal:AbortSignal.timeout(4000)});const result=await r.json();if(result.id&&/^[a-f0-9-]{36}$/.test(result.id))process.stdout.write('SET VARIABLE FOLLOWUP_ID '+result.id+'\n');else process.exit(0);}
 catch{process.exit(0);}
});
setTimeout(()=>process.exit(1),5000).unref();
