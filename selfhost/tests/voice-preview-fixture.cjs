'use strict';
// Local fixture for voice UI review: no DB and no clinical API writes.
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const C=require('../server/calling'),speech=require('../server/speech'),A=require('../server/followup-agent');
function createFixture(){
 const requests=[],utterances=[],originals={speak:speech.speak,available:A.available};
 const settings={gate:null,fail:false,live:false};
 speech.speak=async(text,signal,voice)=>{
  utterances.push({text,voice});if(settings.gate)await settings.gate;if(settings.fail)throw Error('测试语音服务不可用');
  if(settings.live){const file=voice.id==='xiaoyi'?'xiaoyi':voice.id==='yunxi'?'yunxi':voice.speed==='slow'?'slower':'recommended';return (await fs.readFile(path.resolve(__dirname,'../../docs/voice-samples',file+'.mp3'))).toString('base64');}
  return 'dGVzdA==';
 };
 A.available=()=>true;
 const webapp=path.resolve(__dirname,'../webapp'),shared=new Set(['patient-validation.js','prenatal-data.js','customer-validation.js']);
 const server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/cs-admin'&&req.method==='POST'){
   let body='';for await(const chunk of req)body+=chunk;const e=JSON.parse(body);requests.push(e);let r;
   if(e.action==='login')r={ok:true,token:'voice-preview-qa',user:{id:'voice-preview-qa',role:'admin',display_name:'试听测试'}};
   else if(e.token!=='voice-preview-qa')r={ok:false,unauthorized:true};
   else if(e.action==='logout')r={ok:true};
   else if(e.action==='calling_phone_list')r={ok:true,items:[],hasMore:false};
   else if(['calling_status','calling_voice_preview','calling_start','calling_turn','calling_end'].includes(e.action))r=await C.main({...e,recordedBy:'voice-preview-qa'});
   else r={ok:false,error:'此本地页面只用于声音试听'};
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(r));return;
  }
  const name=url.pathname.slice(1),file=shared.has(name.slice(3))&&name.startsWith('js/')?path.resolve(__dirname,'../server',name.slice(3)):path.resolve(webapp,name||'admin.html');
  if(!file.startsWith(webapp+path.sep)&&!shared.has(path.basename(file))){res.writeHead(403);res.end();return;}
  const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream')+'; charset=utf-8','Cache-Control':'no-store'});res.end(data);
 }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:error.message}));}});
 server.on('close',()=>{speech.speak=originals.speak;A.available=originals.available;});
 return {server,settings,requests,utterances};
}
if(require.main===module){const {server,settings}=createFixture();settings.live=true;server.listen(Number(process.env.VOICE_PREVIEW_PORT||28856),'127.0.0.1',()=>console.log('Voice preview: http://127.0.0.1:'+server.address().port+'/admin.html#calling (qa / local)'));}
module.exports={createFixture};
