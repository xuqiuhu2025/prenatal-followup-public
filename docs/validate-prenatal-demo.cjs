'use strict';

const fs=require('node:fs');
const path=require('node:path');
const D=require('../selfhost/server/prenatal-data');
const Patient=require('../selfhost/server/patient-validation');
const file=path.join(__dirname,'prenatal-followup-fictional-demo.csv');
const [header,...lines]=fs.readFileSync(file,'utf8').trim().split(/\r?\n/);
const columns=header.split(','),mapping=D.guessMapping(columns);
const rows=lines.map((line,index)=>{
 const values=line.split(','),row={};
 for(const field of D.fields){const column=mapping[field.key];if(column>=0)row[field.key]=values[column];}
 row.row=index+2;
 return row;
});
const checked=D.validateRows(rows),invalid=checked.filter(row=>row.errors.length);
for(const row of checked){
 const markup=Patient.dialLink(row.data.phone,'一键拨号',{patient_no:row.data.patient_no});
 if(markup.includes('tel:')||!markup.includes('禁止拨号'))invalid.push({row:row.row,errors:['演示档案拨号保护失效']});
}
const real=Patient.dialLink('13800138000','一键拨号',{patient_no:'REAL-001'});
if(!real.includes('tel:+8613800138000'))invalid.push({row:0,errors:['真实档案拨号行为意外变化']});
console.log(JSON.stringify({
 file:path.basename(file),
 rows:checked.length,
 valid:checked.length-invalid.length,
 invalid:invalid.map(row=>({row:row.row,errors:row.errors})),
 phone:'format-validated in memory; all DEMO records render with dialing disabled',
 databaseWrites:0,
 dialing:0
},null,2));
if(invalid.length)process.exitCode=1;
