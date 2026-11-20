'use strict';
const {isIP}=require('node:net');
const PRIVATE=['6001','6002'],PUBLIC=['6003','6004'];
function validatePublic(config){
 if(!config)return null;
 if(!/^[a-z0-9.-]+$/.test(config.host||'')||!config.host.includes('.')||isIP(config.address)!==4||isIP(config.bindAddress)!==4||!Number.isInteger(config.port)||config.port<1024||config.port>65535)throw Error('Invalid public phone configuration');
 return config;
}
function pjsipConfig({privateIp,clientIp,publicConfig,accounts}){
 const pub=validatePublic(publicConfig);
 if(isIP(privateIp)!==4||isIP(clientIp)!==4)throw Error('Invalid private phone address');
 let value='[transport-private]\ntype=transport\nprotocol=tcp\nbind='+privateIp+':5096\n';
 // TLS terminates in the Node frontend; this transport never leaves loopback.
 if(pub)value+='\n[transport-public]\ntype=transport\nprotocol=tcp\nbind=127.0.0.1:5097\nlocal_net=127.0.0.1/32\nexternal_signaling_address='+pub.address+'\nexternal_signaling_port='+pub.port+'\nexternal_media_address='+pub.address+'\n';
 for(const extension of [...PRIVATE,...(pub?PUBLIC:[])]){
  if(!/^[a-f0-9]{48}$/.test(accounts[extension]||''))throw Error('Missing or invalid phone credential');
  const mobile=PUBLIC.includes(extension);
  value+='\n['+extension+']\ntype=endpoint\ntransport=transport-'+(mobile?'public':'private')+'\ncontext=softphone-test\ndisallow=all\nallow=ulaw,alaw\nauth=auth-'+extension+'\naors='+extension+'\ndirect_media=no\nmedia_address='+(mobile?pub.bindAddress:privateIp)+'\nbind_rtp_to_media_address=yes\nrtp_symmetric=yes\nforce_rport=yes\nrewrite_contact=yes\ntrust_id_inbound=no\ncallerid="Test '+extension+'" <'+extension+'>\n';
  if(mobile)value+='media_encryption=sdes\nmedia_encryption_optimistic=no\nuse_avpf=no\nrtcp_mux=no\nrtp_keepalive=5\nrtp_timeout=45\ndeny=0.0.0.0/0\npermit=127.0.0.1/32\n';
  else value+='deny=0.0.0.0/0\npermit='+clientIp+'/32\n'+(pub?'':'permit=127.0.0.1/32\n');
  value+='['+extension+']\ntype=aor\nmax_contacts=1\nremove_existing=yes\nqualify_frequency=25\nminimum_expiration=60\ndefault_expiration=120\nmaximum_expiration=600\n[auth-'+extension+']\ntype=auth\nauth_type=userpass\nusername='+extension+'\npassword='+accounts[extension]+'\n';
 }
 return value;
}
module.exports={PRIVATE,PUBLIC,validatePublic,pjsipConfig};
