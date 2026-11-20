const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const db=require('../server/db'),accounts=require('../server/accounts'),hospital=require('../server/hospital'),admin=require('../server/admin');
const initial=require('./require-test-password.cjs')();
async function request(action,token,data={}){return admin.main({action,token,...data},{ip:'qa-integration'});}
async function ok(action,token,data={}){const r=await request(action,token,data);assert.equal(r.ok,true,JSON.stringify(r));return r;}
async function login(username,password){return ok('login',null,{username,password});}
(async()=>{
 assert.match(process.env.DATABASE_URL||'',/\/cs_accounts_qa_20261110$/);
 await hospital.ensureSchema();await accounts.ensureSchema();await accounts.ensureSchema();await require('../server/prenatal').ensureSchema();
 assert.equal((await db.q('SELECT count(*)::int n FROM staff_accounts'))[0].n,1);
 const a=await login('ADMIN',initial),token=a.token;
 assert.equal(a.user.username,'admin');assert.equal(a.user.password_hash,undefined);
 const second=await login('admin',initial);assert.notEqual(second.token,token);
 const stored=(await db.q('SELECT * FROM staff_sessions'))[0];assert.notEqual(stored.token_hash,token);
 const legacy=crypto.createHash('sha256').update(initial+'cs-admin-static-salt-v1').digest('hex');assert.equal((await request('patient_list',legacy)).unauthorized,true);
 assert.equal((await request('login',null,{username:'admin',password:'wrong'})).ok,false);
 const base={username:'nurse01',displayName:'王护士',department:'呼吸内科',role:'staff',password:'Nurse-test-2026'};
 const staff=(await ok('account_save',token,base)).user;assert.equal(staff.password_hash,undefined);
 assert.equal((await request('account_save',token,{...base,username:'NURSE01'})).ok,false);
 assert.equal((await request('account_save',token,{...base,username:'weak',password:'123'})).ok,false);
 assert.equal((await request('account_save',token,{...base,username:'bad space'})).ok,false);
 const nurse=await login('nurse01',base.password);
 for(const action of ['account_list','account_save','account_reset','account_status'])assert.equal((await request(action,nurse.token,{...base,id:a.user.id})).forbidden,true);
 assert.equal((await ok('hospital_overview',nurse.token)).ok,true);
 const p=await ok('patient_save',nurse.token,{requestId:crypto.randomUUID(),patient:{patient_no:'ACCT-TEST',name:'账号关联测试',phone:'13800138000'}});assert.equal(p.inserted,1);
 const patient=(await ok('patient_list',nurse.token)).list[0];
 const plan=await ok('followup_create',nurse.token,{requestId:crypto.randomUUID(),patientId:patient.id,title:'账号验证随访',assignedTo:'王护士',channel:'phone',mode:'single',dueDate:'2026-11-10'});
 await ok('followup_record',nurse.token,{requestId:crypto.randomUUID(),taskId:plan.ids[0],operator:'伪造记录人',recordedBy:a.user.id,contact:'reached',notes:'独立测试库记录'});
 const r=(await db.q('SELECT * FROM followup_records'))[0];assert.equal(r.operator,'王护士');assert.equal(r.recorded_by,staff.id);
 assert.equal((await request('account_status',token,{id:a.user.id,enabled:false})).ok,false);
 assert.equal((await request('account_save',token,{id:a.user.id,displayName:'系统管理员',department:'',role:'staff'})).ok,false);
 await ok('account_status',token,{id:staff.id,enabled:false});assert.equal((await request('session',nurse.token)).unauthorized,true);assert.equal((await request('login',null,{username:'nurse01',password:base.password})).ok,false);
 await ok('account_status',token,{id:staff.id,enabled:true});const enabled=await login('nurse01',base.password);
 await ok('account_reset',token,{id:staff.id,password:'Reset-test-2026'});assert.equal((await request('session',enabled.token)).unauthorized,true);assert.equal((await request('login',null,{username:'nurse01',password:base.password})).ok,false);
 const changed=await login('nurse01','Reset-test-2026');assert.equal((await request('password_change',changed.token,{currentPassword:'incorrect',password:'Self-test-2026'})).ok,false);
 await ok('password_change',changed.token,{currentPassword:'Reset-test-2026',password:'Self-test-2026'});assert.equal((await request('session',changed.token)).unauthorized,true);
 const own=await login('nurse01','Self-test-2026');await ok('logout',own.token);assert.equal((await request('session',own.token)).unauthorized,true);
 const expiring=await login('nurse01','Self-test-2026');await db.q("UPDATE staff_sessions SET expires_at=now()-interval '1 second' WHERE account_id=$1",[staff.id]);assert.equal((await request('session',expiring.token)).unauthorized,true);
 const promoted=await login('nurse01','Self-test-2026');await ok('account_save',token,{id:staff.id,displayName:'<img onerror=alert(1)>',department:'100%_科室',role:'admin'});assert.equal((await request('session',promoted.token)).unauthorized,true);
 assert.equal((await ok('account_list',token,{keyword:'%_'})).total,1);assert.equal((await ok('account_list',token,{keyword:"' OR 1=1 --"})).total,0);
 const promotedAdmin=await login('nurse01','Self-test-2026');
 const races=await Promise.all([request('account_status',token,{id:staff.id,enabled:false}),request('account_status',promotedAdmin.token,{id:a.user.id,enabled:false})]);assert.equal(races.filter(x=>x.ok).length,1);assert.equal((await db.q("SELECT count(*)::int n FROM staff_accounts WHERE enabled AND role='admin'"))[0].n,1);
 // Restore only this test fixture, then prove startup does not reset changed credentials.
 await db.q('UPDATE staff_accounts SET enabled=true');const fresh=await login('admin',initial);
 await ok('password_change',fresh.token,{currentPassword:initial,password:'Admin-changed-2026'});await accounts.ensureSchema();assert.equal((await request('login',null,{username:'admin',password:initial})).ok,false);await login('admin','Admin-changed-2026');
 const hashes=await db.q('SELECT password_hash FROM staff_accounts');hashes.forEach(x=>{assert.match(x.password_hash,/^scrypt\$/);assert.ok(!x.password_hash.includes('2026'));});
 const audit=await db.q('SELECT * FROM staff_audit');for(const action of ['bootstrap','create','disable','enable','reset_password','change_password','edit'])assert.ok(audit.some(r=>r.action===action),'missing audit '+action);assert.ok(!JSON.stringify(audit).includes('Self-test'));
 for(let i=0;i<11;i++)await admin.main({action:'login',username:'rate-test',password:'wrong'},{ip:'qa-rate'});
 assert.match((await admin.main({action:'login',username:'rate-test',password:'wrong'},{ip:'qa-rate'})).error,/频繁/);
 console.log('PASS accounts: migration, bootstrap, hashed passwords/sessions, roles, validation, record attribution, revocation, expiry, reset/change/logout, concurrent administrator protection, audit and throttling.');
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1);});
