(function(){
 let id=sessionStorage.getItem('hospital_guidance_session');
 if(!/^h_[a-f0-9-]{36}$/i.test(id||'')){
  const b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;
  const s=Array.from(b,n=>n.toString(16).padStart(2,'0')).join('');
  id='h_'+s.slice(0,8)+'-'+s.slice(8,12)+'-'+s.slice(12,16)+'-'+s.slice(16,20)+'-'+s.slice(20);
  sessionStorage.setItem('hospital_guidance_session',id);
 }
 window.HospitalSession=id;
})();
