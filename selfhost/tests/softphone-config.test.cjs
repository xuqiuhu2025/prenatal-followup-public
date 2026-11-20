'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),os=require('node:os'),fs=require('node:fs/promises'),path=require('node:path');
const {pjsipConfig}=require('../telephony/softphone/phone-config.cjs'),P=require('../telephony/softphone/provisioning.cjs');
const config={host:'test.example.org',address:'203.0.113.9',bindAddress:'192.0.2.10',port:28861};
const credentials={accounts:Object.fromEntries(['6001','6002','6003','6004'].map(id=>[id,'a'.repeat(48)]))};
test('TLS boundary handles fragmented SIP and preserves the encrypted-media SDP',async()=>{
 const {SipBoundary}=require('../telephony/softphone/tls-front.cjs');
 const body='v=0\r\na=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:fake-key\r\n';
 const input='INVITE sip:7000@test;transport=tls SIP/2.0\r\nVia: SIP/2.0/TLS phone:5010;branch=qa\r\nContact: <sip:6004@phone;transport=tls>\r\nContent-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body;
 const parser=new SipBoundary(true),chunks=[];parser.on('data',b=>chunks.push(b));parser.write(input.slice(0,37));parser.write(input.slice(37));parser.end();
 const output=Buffer.concat(chunks).toString();assert.match(output,/Via: SIP\/2\.0\/TCP/);assert.match(output,/Contact:.*transport=tcp/);assert.equal(output.split('\r\n\r\n')[1],body);
 const back=new SipBoundary(false),reverse=[];back.on('data',b=>reverse.push(b));back.end(output);assert.equal(Buffer.concat(reverse).toString(),input);
});
test('enabling public phones preserves private endpoint ACLs and requires SRTP',()=>{
 const base={privateIp:'100.64.0.10',clientIp:'100.64.0.20',accounts:credentials.accounts};
 const privateOnly=pjsipConfig(base);assert(!privateOnly.includes('[6003]'));assert(!privateOnly.includes('protocol=tls'));
 const both=pjsipConfig({...base,publicConfig:config});assert.match(both,/bind=100\.64\.0\.10:5096/);assert.match(both,/bind=127\.0\.0\.1:5097/);assert.match(both,/external_signaling_port=28861/);
 for(const id of ['6001','6002']){const endpoint=both.split('['+id+']')[1];assert.match(endpoint,/permit=100\.64\.0\.20\/32/);assert(!endpoint.includes('permit=127.0.0.1'));assert.match(endpoint,/media_address=100\.64\.0\.10/);}
 for(const id of ['6003','6004']){const endpoint=both.split('['+id+']')[1];assert.match(endpoint,/transport=transport-public/);assert.match(endpoint,/media_encryption=sdes/);assert.match(endpoint,/media_encryption_optimistic=no/);assert.match(endpoint,/auth=auth-/);}
 assert.throws(()=>pjsipConfig({...base,publicConfig:{...config,host:'bad\nconfig'}}));
});

test('public TLS boundary advertises reachable signaling/media and preserves SRTP keys',()=>{
 const {SipBoundary}=require('../telephony/softphone/tls-front.cjs');
 const edge={...config,peerAddress:'198.51.100.5',peerPort:45000};
 const transform=(input,incoming)=>{const parser=new SipBoundary(incoming,edge),chunks=[];parser.on('data',b=>chunks.push(b));parser.end(input);return Buffer.concat(chunks).toString();};
 const sdp='v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nc=IN IP4 127.0.0.1\r\nm=audio 18160 RTP/SAVP 0\r\na=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:fake-key\r\n';
 const request='INVITE sip:6004@127.0.0.1:52000;transport=tcp SIP/2.0\r\nVia: SIP/2.0/TCP 127.0.0.1:5097;branch=test;rport\r\nTo: <sip:6004@127.0.0.1>\r\nContact: <sip:asterisk@127.0.0.1:5097;transport=tcp>\r\nContent-Type: application/sdp\r\nContent-Length: '+Buffer.byteLength(sdp)+'\r\n\r\n'+sdp;
 const publicRequest=transform(request,false);
 assert.match(publicRequest,/INVITE sip:6004@198\.51\.100\.5:45000;transport=tls/);
 assert.match(publicRequest,/Contact: <sip:asterisk@test\.example\.org:28861;transport=tls>/);
 assert.match(publicRequest,/c=IN IP4 203\.0\.113\.9/);assert(!publicRequest.includes('127.0.0.1'));
 assert(publicRequest.includes('a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:fake-key'));
 assert.equal(Number(publicRequest.match(/Content-Length: (\d+)/)[1]),Buffer.byteLength(publicRequest.split('\r\n\r\n')[1]));
 const response='SIP/2.0 200 OK\r\nVia: SIP/2.0/TCP 192.168.8.103:9000;rport=52000;received=127.0.0.1;branch=test\r\nContact: <sip:6004@127.0.0.1:52000;transport=tcp>\r\nContent-Length: 0\r\n\r\n';
 const publicResponse=transform(response,false);
 assert.match(publicResponse,/rport=45000;received=198\.51\.100\.5/);assert(!publicResponse.includes('127.0.0.1'));
 const clientResponse=publicRequest.replace(/^INVITE[^\r\n]*/,'SIP/2.0 200 OK');
 const privateResponse=transform(clientResponse,true);
 assert.match(privateResponse,/Via: SIP\/2\.0\/TCP 127\.0\.0\.1:5097/);
 assert.match(privateResponse,/c=IN IP4 198\.51\.100\.5/);
});
test('provisioning denies unknown/expired tokens and private accounts; successful response is not cacheable',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'followup-config-'));
 try{
  await assert.rejects(P.create(root,config,'6001'));
  const link=await P.create(root,config,'6003'),pathname=new URL(link.url).pathname;
  const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=body;}});
  const fetch=async(p,method='GET')=>{const res=response();await P.serve({root,config,credentials,req:{method},res,pathname:p});return res;};
  let res=await fetch(pathname);assert.equal(res.headers['Cache-Control'],'no-store');assert.match(res.body,/media_encryption_mandatory" overwrite="true">1/);assert.match(res.body,/transport=tls/);assert(!res.body.includes('100.64.0.10'));assert.match(res.body,/verify_server_certs" overwrite="true">1/);
  assert.equal((await fetch(pathname,'HEAD')).body,undefined);assert.equal((await fetch(pathname,'POST')).statusCode,404);
  assert.equal((await fetch('/followup-setup/'+('b'.repeat(64))+'.xml')).statusCode,404);
  const file=path.join(root,'provisioning',path.basename(pathname,'.xml')+'.json');await fs.writeFile(file,JSON.stringify({extension:'6003',expiresAt:'2000-01-01T00:00:00Z'}));
  assert.equal((await fetch(pathname)).statusCode,404);
 }finally{const actual=await fs.realpath(root),expected=await fs.realpath(os.tmpdir());assert.equal(path.dirname(actual),expected);assert(path.basename(actual).startsWith('followup-config-'));await fs.rm(actual,{recursive:true,force:true});}
});
