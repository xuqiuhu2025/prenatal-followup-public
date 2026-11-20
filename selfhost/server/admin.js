// Hospital administration: authenticated staff access only.
const hospital = require('./hospital');
const accounts = require('./accounts');
async function main(event,context) {
 if(typeof event.action!=='string')return {ok:false,error:'无效操作'};
 const result=await accounts.main(event,context);
 if('ok' in result)return result;
 const data={...event,operator:result.user.display_name,recordedBy:result.user.id};
 if(event.action.startsWith('calling_'))return require('./calling').main(data);
 return event.action.startsWith('prenatal_')?require('./prenatal').main(data):hospital.main(data);
}
module.exports = {main};
