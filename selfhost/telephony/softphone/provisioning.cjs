'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {PUBLIC}=require('./phone-config.cjs');
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function xml(config,extension,password){
 if(!PUBLIC.includes(extension))throw Error('Not a mobile test account');
 const route='sip:'+config.host+':'+config.port+';transport=tls';
 const sections={
  misc:{transient_provisioning:1},
  sip:{default_proxy:0,media_encryption:'srtp',media_encryption_mandatory:1,verify_server_certs:1,verify_server_cn:1,ipv6:0},
  video:{automatically_initiate:0,automatically_accept:0},
  proxy_0:{reg_identity:'"随访手机测试" <sip:'+extension+'@'+config.host+'>',reg_proxy:route,reg_route:route,reg_sendregister:1,reg_expires:120,publish:0,avpf:0,nat_policy_ref:'followup-public',push_notification_allowed:0,remote_push_notification_allowed:0},
  auth_info_0:{username:extension,userid:extension,passwd:password,realm:'asterisk',domain:config.host},
  nat_policy_0:{ref:'followup-public',stun_enabled:0,ice_enabled:0,turn_enabled:0,upnp_enabled:0}
 };
 return '<?xml version="1.0" encoding="UTF-8"?>\n<config xmlns="http://www.linphone.org/xsds/lpconfig.xsd">\n'+Object.entries(sections).map(([name,entries])=>'  <section name="'+name+'">\n'+Object.entries(entries).map(([key,value])=>'    <entry name="'+key+'" overwrite="true">'+escape(value)+'</entry>').join('\n')+'\n  </section>').join('\n')+'\n</config>\n';
}
async function create(root,config,extension){
 if(!PUBLIC.includes(extension))throw Error('Not a mobile test account');
 const token=crypto.randomBytes(32).toString('hex'),expiresAt=new Date(Date.now()+72*3600000).toISOString();
 const dir=path.join(root,'provisioning');await fs.mkdir(dir,{recursive:true,mode:0o700});
 const record={extension,expiresAt};await fs.writeFile(path.join(dir,token+'.json'),JSON.stringify(record),{mode:0o600});
 return {username:extension,domain:config.host,port:config.port,transport:'TLS',media:'SRTP',url:'https://'+config.host+'/followup-setup/'+token+'.xml',expiresAt};
}
async function serve({root,config,credentials,req,res,pathname}){
 const match=pathname.match(/^\/followup-setup\/([a-f0-9]{64})\.xml$/);
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');res.setHeader('Referrer-Policy','no-referrer');
 if(!config||!match||!['GET','HEAD'].includes(req.method)){res.statusCode=404;res.end();return;}
 let record;try{record=JSON.parse(await fs.readFile(path.join(root,'provisioning',match[1]+'.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!record||!PUBLIC.includes(record.extension)||!(Date.parse(record.expiresAt)>Date.now())){res.statusCode=404;res.end();return;}
 const body=xml(config,record.extension,credentials.accounts[record.extension]);
 res.setHeader('Content-Type','application/xml; charset=utf-8');res.end(req.method==='HEAD'?undefined:body);
}
module.exports={xml,create,serve};
