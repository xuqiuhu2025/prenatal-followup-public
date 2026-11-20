const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {promisify} = require('util');
const db = require('./db');
const scrypt = promisify(crypto.scrypt);
const digest = v => crypto.createHash('sha256').update(v).digest('hex');
const publicColumns = 'id,username,display_name,department,role,enabled,last_login_at,created_at,updated_at';
const publicUser = u => Object.fromEntries(publicColumns.split(',').map(k => [k,u[k]]));
const LOCK = 73429314;
function password(value) {
 if (typeof value !== 'string' || value.length < 8 || value.length > 128 || !value.trim()) throw Error('密码须为 8–128 位，不能全为空格');
 return value;
}
async function hashPassword(value) {
 const salt = crypto.randomBytes(16).toString('hex');
 const key = await scrypt(value,salt,64);
 return 'scrypt$'+salt+'$'+key.toString('hex');
}
async function verifyPassword(value,stored) {
 if (typeof value !== 'string' || value.length > 128) return false;
 const [,salt,hex] = String(stored).split('$');
 if (!salt || !/^[a-f0-9]{128}$/.test(hex||'')) return false;
 return crypto.timingSafeEqual(await scrypt(value,salt,64),Buffer.from(hex,'hex'));
}
function bounded(value,max,label,required=false) {
 if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw Error(label+'格式不正确');
 return value.trim();
}
function accountId(v) {if (!/^[1-9]\d{0,15}$/.test(String(v))) throw Error('账号编号无效');return String(v);}
async function audit(c,actor,target,action,detail={}) {await c.query('INSERT INTO staff_audit(actor_id,target_id,action,detail) VALUES($1,$2,$3,$4)',[actor,target,action,detail]);}
async function ensureSchema() {
 const bundled=path.join(__dirname,'accounts-schema.sql');
 await db.q(fs.readFileSync(fs.existsSync(bundled)?bundled:path.join(__dirname,'../init/05-accounts.sql'),'utf8'));
 // Only seed an empty account table. A restart never resets a password or re-enables an account.
 await db.withTransaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock($1)',[LOCK]);
  if ((await c.query('SELECT id FROM staff_accounts LIMIT 1')).rowCount) return;
  const initialPassword=process.env.ADMIN_PASSWORD;
  if(typeof initialPassword!=='string'||!initialPassword.trim())throw Error('首次启动须配置 ADMIN_PASSWORD');
  const hash=await hashPassword(password(initialPassword));
  const r=await c.query("INSERT INTO staff_accounts(username,display_name,role,password_hash) VALUES('admin','系统管理员','admin',$1) RETURNING id",[hash]);
  await audit(c,null,r.rows[0].id,'bootstrap');
 });
}
// Fixed windows are bounded in memory; use the TCP peer, never a caller-supplied forwarded header.
const attempts=new Map();
function attempt(key,max) {
 const now=Date.now();
 for(const [k,v] of attempts) if(v.until<=now) attempts.delete(k);
 if(attempts.size>=10000&&!attempts.has(key)) return false;
 const entry=attempts.get(key)||{count:0,until:now+15*60000};
 entry.count++;attempts.set(key,entry);return entry.count<=max;
}
const dummyHash='scrypt$00000000000000000000000000000000$'+'0'.repeat(128);
async function login(e,context={}) {
 const username=typeof e.username==='string'?e.username.trim().toLowerCase():'';
 const peer=String(context.ip||'local').slice(0,100);
 if(!attempt('ip:'+peer,100)||!attempt('user:'+peer+':'+username.slice(0,40),10)) return {ok:false,error:'登录尝试过于频繁，请 15 分钟后再试'};
 if(!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)||typeof e.password!=='string'||e.password.length>128)return {ok:false,error:'账号或密码错误，或账号已停用'};
 const found=await db.q('SELECT * FROM staff_accounts WHERE username=$1',[username]);
 const u=found[0];const valid=await verifyPassword(e.password,u?.password_hash||dummyHash);
 if(!u||!u.enabled||!valid)return {ok:false,error:'账号或密码错误，或账号已停用'};
 return db.withTransaction(async c=>{
  const current=(await c.query('SELECT * FROM staff_accounts WHERE id=$1 FOR UPDATE',[u.id])).rows[0];
  if(!current.enabled||current.password_hash!==u.password_hash)return {ok:false,error:'账号状态已变化，请重新登录'};
  const token=crypto.randomBytes(32).toString('hex');
  await c.query('DELETE FROM staff_sessions WHERE expires_at<=now()');
  const session=await c.query("INSERT INTO staff_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '12 hours') RETURNING expires_at",[digest(token),u.id]);
  await c.query('UPDATE staff_accounts SET last_login_at=now() WHERE id=$1',[u.id]);
  attempts.delete('user:'+peer+':'+username);
  return {ok:true,token,user:publicUser(current),expiresAt:session.rows[0].expires_at};
 });
}
async function authenticate(token,client) {
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;
 const sql='SELECT a.* FROM staff_sessions s JOIN staff_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.enabled';
 const rows=client?(await client.query(sql,[digest(token)])).rows:await db.q(sql,[digest(token)]);
 return rows[0]||null;
}
async function requireAdmin(c,token) {
 const actor=await authenticate(token,c);if(!actor||actor.role!=='admin')throw Error('仅管理员可管理账号');return actor;
}
async function list(e) {
 const page=Math.min(100000,Math.max(1,parseInt(e.page,10)||1));
 const keyword=String(e.keyword||'').slice(0,80).split('').map(c=>[String.fromCharCode(92),'%','_'].includes(c)?String.fromCharCode(92)+c:c).join('');
 const role=['admin','staff'].includes(e.role)?e.role:'';
 const status=['enabled','disabled'].includes(e.status)?e.status:'';
 const where=" WHERE (username ILIKE $1 OR display_name ILIKE $1 OR department ILIKE $1) AND ($2='' OR role=$2) AND ($3='' OR enabled=($3='enabled'))";
 const params=['%'+keyword+'%',role,status];
 const [rows,count,summary]=await Promise.all([
  db.q('SELECT '+publicColumns+' FROM staff_accounts'+where+' ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET $4',[...params,(page-1)*20]),
  db.q('SELECT count(*)::int total FROM staff_accounts'+where,params),
  db.q("SELECT count(*)::int total,count(*) FILTER(WHERE enabled)::int enabled,count(*) FILTER(WHERE enabled AND role='admin')::int admins FROM staff_accounts")
 ]);
 return {ok:true,list:rows,total:count[0].total,page,pageSize:20,summary:summary[0]};
}
async function save(e) {
 const name=bounded(e.displayName,80,'姓名',true),department=bounded(e.department||'',80,'科室');
 if(!['admin','staff'].includes(e.role))throw Error('请选择有效角色');
 const target=e.id?accountId(e.id):null;
 let username,hash;
 if(!target){username=bounded(e.username,40,'登录账号',true).toLowerCase();if(!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username))throw Error('登录账号须为 3–40 位字母、数字、点、横线或下划线，以字母或数字开头');hash=await hashPassword(password(e.password));}
 return db.withTransaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock($1)',[LOCK]);
  const actor=await requireAdmin(c,e.token);
  if(!target){
   const r=await c.query('INSERT INTO staff_accounts(username,display_name,department,role,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING '+publicColumns,[username,name,department,e.role,hash]);
   await audit(c,actor.id,r.rows[0].id,'create',{username,role:e.role});return {ok:true,user:r.rows[0]};
  }
  const u=(await c.query('SELECT * FROM staff_accounts WHERE id=$1 FOR UPDATE',[target])).rows[0];if(!u)throw Error('账号不存在');
  if(String(actor.id)===target&&e.role!==u.role)throw Error('不能修改自己的管理员角色，请由其他管理员操作');
  await protectLastAdmin(c,u,e.role,u.enabled);
  const r=await c.query('UPDATE staff_accounts SET display_name=$2,department=$3,role=$4,updated_at=now() WHERE id=$1 RETURNING '+publicColumns,[target,name,department,e.role]);
  if(u.role!==e.role)await c.query('DELETE FROM staff_sessions WHERE account_id=$1',[target]);
  await audit(c,actor.id,target,'edit',{roleBefore:u.role,roleAfter:e.role});return {ok:true,user:r.rows[0]};
 });
}
async function protectLastAdmin(c,u,role,enabled) {
 if(u.enabled&&u.role==='admin'&&(!enabled||role!=='admin')){
  const n=(await c.query("SELECT count(*)::int n FROM staff_accounts WHERE role='admin' AND enabled")).rows[0].n;
  if(n<=1)throw Error('必须保留至少一个启用的管理员');
 }
}
async function setEnabled(e) {
 const target=accountId(e.id);if(typeof e.enabled!=='boolean')throw Error('账号状态无效');
 return db.withTransaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock($1)',[LOCK]);const actor=await requireAdmin(c,e.token);
  if(String(actor.id)===target&&!e.enabled)throw Error('不能停用自己的账号');
  const u=(await c.query('SELECT * FROM staff_accounts WHERE id=$1 FOR UPDATE',[target])).rows[0];if(!u)throw Error('账号不存在');
  await protectLastAdmin(c,u,u.role,e.enabled);
  await c.query('UPDATE staff_accounts SET enabled=$2,updated_at=now() WHERE id=$1',[target,e.enabled]);
  if(!e.enabled)await c.query('DELETE FROM staff_sessions WHERE account_id=$1',[target]);
  await audit(c,actor.id,target,e.enabled?'enable':'disable');return {ok:true};
 });
}
async function resetPassword(e) {
 const target=accountId(e.id),hash=await hashPassword(password(e.password));
 return db.withTransaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock($1)',[LOCK]);const actor=await requireAdmin(c,e.token);
  if(String(actor.id)===target)throw Error('请通过“修改我的密码”修改自己的密码');
  const r=await c.query('UPDATE staff_accounts SET password_hash=$2,updated_at=now() WHERE id=$1 RETURNING id',[target,hash]);if(!r.rowCount)throw Error('账号不存在');
  await c.query('DELETE FROM staff_sessions WHERE account_id=$1',[target]);await audit(c,actor.id,target,'reset_password');return {ok:true};
 });
}
async function changePassword(e,user) {
 password(e.password);if(e.password===e.currentPassword)throw Error('新密码不能与原密码相同');
 if(!await verifyPassword(e.currentPassword,user.password_hash))throw Error('原密码不正确');
 const hash=await hashPassword(e.password);
 return db.withTransaction(async c=>{
  const u=(await c.query('SELECT * FROM staff_accounts WHERE id=$1 FOR UPDATE',[user.id])).rows[0];
  if(!u.enabled||u.password_hash!==user.password_hash||!await authenticate(e.token,c))throw Error('账号状态已变化，请重新登录');
  await c.query('UPDATE staff_accounts SET password_hash=$2,updated_at=now() WHERE id=$1',[user.id,hash]);
  await c.query('DELETE FROM staff_sessions WHERE account_id=$1',[user.id]);await audit(c,user.id,user.id,'change_password');return {ok:true,relogin:true};
 });
}
async function main(e,context={}) {
 try{
  if(e.action==='login')return await login(e,context);
  const user=await authenticate(e.token);
  if(!user)return {ok:false,unauthorized:true,error:'登录已失效，请重新登录'};
  if(e.action==='session')return {ok:true,user:publicUser(user)};
  if(e.action==='logout'){await db.q('DELETE FROM staff_sessions WHERE token_hash=$1',[digest(e.token)]);return {ok:true};}
  if(e.action==='password_change')return await changePassword(e,user);
  if(e.action.startsWith('account_')){
   if(user.role!=='admin')return {ok:false,forbidden:true,error:'仅管理员可管理账号'};
   if(e.action==='account_list')return await list(e);
   if(e.action==='account_save')return await save(e);
   if(e.action==='account_status')return await setEnabled(e);
   if(e.action==='account_reset')return await resetPassword(e);
   return {ok:false,error:'未知账号操作'};
  }
  return {user};
 }catch(err){if(err.code){console.error('account database error',err.code);return {ok:false,error:err.code==='23505'?'登录账号已存在':'账号操作失败，请重试'};}return {ok:false,error:err.message||'账号操作失败'};}
}
module.exports={ensureSchema,main,hashPassword,verifyPassword};
