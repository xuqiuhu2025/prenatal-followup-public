'use strict';
// Test credentials are supplied locally, never embedded in the source backup.
module.exports=function requireTestPassword(){
  const value=process.env.QA_PASSWORD||process.env.ADMIN_PASSWORD;
  if(typeof value!=='string'||!value.trim())throw Error('请为测试配置 QA_PASSWORD 或 ADMIN_PASSWORD；首次初始化测试库须配置 ADMIN_PASSWORD');
  return value;
};
