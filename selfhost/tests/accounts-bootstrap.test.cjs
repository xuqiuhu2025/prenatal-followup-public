'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
function load(file,env,dependencies={}){
  const sandbox={module:{exports:{}},__dirname:path.dirname(file),process:{env},Buffer,console,require:name=>dependencies[name]||require(name)};
  sandbox.exports=sandbox.module.exports;
  vm.runInNewContext(fs.readFileSync(file,'utf8'),sandbox,{filename:file});return sandbox.module.exports;
}
function accountFixture(env){
  let stored,insertions=0;
  const db={async q(){return [];},async withTransaction(fn){return fn({async query(sql,params){
    if(sql.startsWith('SELECT id FROM staff_accounts'))return {rowCount:stored?1:0};
    if(sql.startsWith('INSERT INTO staff_accounts')){stored=params[0];insertions++;return {rows:[{id:1}]};}
    return {rows:[],rowCount:0};
  }});}};
  return {accounts:load(path.resolve(__dirname,'../server/accounts.js'),env,{'./db':db}),get hash(){return stored;},get insertions(){return insertions;}};
}
test('an empty account database cannot create an administrator without a configured password',async()=>{
  for(const value of [undefined,'','   ','short']){
    const f=accountFixture({ADMIN_PASSWORD:value});
    await assert.rejects(f.accounts.ensureSchema(),/ADMIN_PASSWORD|8–128/);assert.equal(f.insertions,0);
  }
});
test('bootstrap hashes the supplied password and an existing account never resets on startup',async()=>{
  const password=crypto.randomBytes(24).toString('hex'),env={ADMIN_PASSWORD:password},f=accountFixture(env);
  await f.accounts.ensureSchema();assert.equal(f.insertions,1);assert.notEqual(f.hash,password);assert.equal(await f.accounts.verifyPassword(password,f.hash),true);
  const saved=f.hash;delete env.ADMIN_PASSWORD;await f.accounts.ensureSchema();assert.equal(f.insertions,1);assert.equal(f.hash,saved);
});
test('the archived CloudBase admin rejects empty credentials and missing tokens when unconfigured',async()=>{
  const app=load(path.resolve(__dirname,'../../cloudfunctions/cs-admin/index.js'),{}, {'@cloudbase/node-sdk':{init:()=>({rdb:()=>({})})}});
  for(const password of ['',undefined])assert.equal((await app.main({action:'login',password})).ok,false);
  for(const token of [undefined,null,'',crypto.createHash('sha256').update('cs-admin-static-salt-v1').digest('hex')])assert.equal((await app.main({action:'stats',token})).ok,false);
});
test('the archived CloudBase admin still accepts the configured password',async()=>{
  const password=crypto.randomBytes(24).toString('hex');
  const app=load(path.resolve(__dirname,'../../cloudfunctions/cs-admin/index.js'),{ADMIN_PASSWORD:password},{'@cloudbase/node-sdk':{init:()=>({rdb:()=>({})})}});
  assert.equal((await app.main({action:'login',password:'wrong'})).ok,false);
  const result=await app.main({action:'login',password});assert.equal(result.ok,true);assert.match(result.token,/^[a-f0-9]{64}$/);
});
