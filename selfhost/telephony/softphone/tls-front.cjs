'use strict';
const tls=require('node:tls'),net=require('node:net'),fs=require('node:fs/promises'),crypto=require('node:crypto'),{Transform}=require('node:stream');
// Translate the private TCP hop at the TLS edge. SDP keys/codecs stay unchanged;
// only connection addresses change so neither endpoint sends audio to loopback.
class SipBoundary extends Transform{
 constructor(toPbx,edge){super();this.toPbx=toPbx;this.edge=edge;this.pending=Buffer.alloc(0);}
 _transform(chunk,encoding,done){
  try{
   this.pending=Buffer.concat([this.pending,chunk]);
   if(this.pending.length>131072)throw Error('SIP message exceeds limit');
   while(this.pending.length){
    if(this.pending.subarray(0,2).equals(Buffer.from('\r\n'))){this.push(this.pending.subarray(0,2));this.pending=this.pending.subarray(2);continue;}
    const boundary=this.pending.indexOf('\r\n\r\n');if(boundary<0)break;
    const header=this.pending.subarray(0,boundary).toString('latin1'),lengths=[...header.matchAll(/^(?:Content-Length|l):\s*(\d+)\s*$/gmi)].map(m=>Number(m[1]));
    if(lengths.length>1||lengths.some(n=>n>65536))throw Error('Invalid SIP framing');
    const length=lengths[0]||0,end=boundary+4+length;if(this.pending.length<end)break;
    const rewritten=header.replace(/^(Via|v|Contact|m|Route|Record-Route):[^\r\n]*/gmi,line=>this.toPbx?line.replace(/SIP\/2\.0\/TLS/gi,'SIP/2.0/TCP').replace(/;transport=tls/gi,';transport=tcp'):line.replace(/SIP\/2\.0\/TCP/gi,'SIP/2.0/TLS').replace(/;transport=tcp/gi,';transport=tls'));
    let finalHeader=rewritten.replace(/^(?!SIP\/2\.0)[^\r\n]*/,line=>this.toPbx?line.replace(/;transport=tls/gi,';transport=tcp'):line.replace(/;transport=tcp/gi,';transport=tls'));
    let body=this.pending.subarray(boundary+4,end);
    if(this.edge){
     const {host,address,port,peerAddress,peerPort}=this.edge,publicHop=host+':'+port;
     if(this.toPbx){
      // Responses echo our public Via; restore the hop Asterisk originated.
      finalHeader=finalHeader.replace(/^(Via|v):[^\r\n]*/gmi,line=>line.replace('SIP/2.0/TCP '+publicHop,'SIP/2.0/TCP 127.0.0.1:5097'));
     }else{
      finalHeader=finalHeader.split('\r\n').map((line,index)=>{
       if(index!==0&&!/^(?:Via|v|Contact|m|To|t|From|f|Route|Record-Route):/i.test(line))return line;
       if(/^(?:Via|v):/i.test(line)){
        // A response must report the real observed TLS peer, not the TCP relay.
        line=line.replace(/;received=127\.0\.0\.1(?=;|$)/gi,';received='+peerAddress);
        if(line.includes(';received='+peerAddress))line=line.replace(/;rport=\d+/gi,';rport='+peerPort);
       }
       line=line.replace(/127\.0\.0\.1:5097\b/g,publicHop);
       line=line.replace(/127\.0\.0\.1:\d+\b/g,peerAddress+':'+peerPort);
       return line.replace(/@127\.0\.0\.1(?=[;>\s]|$)/g,'@'+host);
      }).join('\r\n');
     }
     if(body.length&&/^(?:Content-Type|c):\s*application\/sdp\b/im.test(finalHeader)){
      const target=this.toPbx?peerAddress:address;
      body=Buffer.from(body.toString('latin1').replace(/^(c=IN IP4 )[^\r\n]+/gm,'$1'+target).replace(/^(o=[^\r\n]+ IN IP4 )[^\r\n]+/gm,'$1'+target).replace(/^(a=rtcp:\d+ IN IP4 )[^\r\n]+/gm,'$1'+target),'latin1');
      finalHeader=finalHeader.replace(/^((?:Content-Length|l):)\s*\d+\s*$/gmi,'$1 '+body.length);
     }
    }
    this.push(Buffer.concat([Buffer.from(finalHeader+'\r\n\r\n','latin1'),body]));this.pending=this.pending.subarray(end);
   }
   done();
  }catch(e){done(e);}
 }
}
async function start(config){
 const read=async()=>({cert:await fs.readFile('/tls/fullchain.pem'),key:await fs.readFile('/tls/privkey.pem')});
 let material=await read(),digest=crypto.createHash('sha256').update(material.cert).digest('hex');
 const peers=new Map(),sessions=new Set();
 const server=tls.createServer({...material,minVersion:'TLSv1.2',handshakeTimeout:8000},socket=>{
  const upstream=net.connect({host:'127.0.0.1',port:5097});sessions.add(socket);
  socket.setNoDelay(true);upstream.setNoDelay(true);socket.setTimeout(900000,()=>socket.destroy());
  socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
  socket.on('close',()=>{upstream.destroy();sessions.delete(socket);});upstream.on('close',()=>socket.destroy());
  const edge={...config,peerAddress:socket.remoteAddress,peerPort:socket.remotePort};
  const incoming=new SipBoundary(true,edge),outgoing=new SipBoundary(false,edge);
  for(const parser of [incoming,outgoing])parser.on('error',()=>{socket.destroy();upstream.destroy();});
  socket.pipe(incoming).pipe(upstream);upstream.pipe(outgoing).pipe(socket);
 });
 server.maxConnections=48;server.on('tlsClientError',()=>{});
 server.on('connection',socket=>{
  const ip=socket.remoteAddress,entry=peers.get(ip)||{count:0};
  if(entry.count>=4){socket.destroy();return;}
  entry.count++;peers.set(ip,entry);socket.on('close',()=>{if(--entry.count<=0)peers.delete(ip);});
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.bindAddress,()=>{server.removeListener('error',reject);resolve();});});
 // 1Panel renews the mounted certificate. Refresh TLS without dropping calls.
 const renewal=setInterval(async()=>{try{const next=await read(),hash=crypto.createHash('sha256').update(next.cert).digest('hex');if(hash!==digest){server.setSecureContext({...next,minVersion:'TLSv1.2'});digest=hash;}}catch{console.error('Phone TLS certificate refresh failed');}},60000);renewal.unref();
 return {close(){clearInterval(renewal);for(const socket of sessions)socket.destroy();server.close();}};
}
module.exports={start,SipBoundary};
