const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../server/db');
const customers = require('../server/customers');
const admin = require('../server/admin');
(async () => {
  assert.match(process.env.DATABASE_URL || '', /cs_import_qa_/);
  await customers.ensureSchema();
  await customers.ensureSchema();
  const request = { requestId: crypto.randomUUID(), strategy: 'skip', source: 'qa.xlsx', rows: [
    { name: 'QA 客户', phone: '+86 138-0013-8000', company: 'Original', notes: 'keep me' },
    { name: 'duplicate', phone: 13800138000 },
    { name: '', phone: '13900139000' },
    { name: 'bad-email', phone: '13900139000', email: 'bad' },
    { name: '<img onerror=alert(1)>', phone: '13900139000', company: '100%_company' }
  ] };
  const r = await customers.importRows(request);
  assert.equal(r.inserted, 2); assert.equal(r.invalid, 3);
  assert.deepEqual(await customers.importRows(request), r);
  await assert.rejects(customers.importRows({ ...request, source: 'changed' }), /改变/);
  const skip = await customers.importRows({ ...request, requestId: crypto.randomUUID(), rows: [{ name: 'Ignore', phone: '13800138000' }] });
  assert.equal(skip.skipped, 1);
  const update = await customers.importRows({ ...request, requestId: crypto.randomUUID(), strategy: 'update', rows: [{ name: 'Updated', phone: '13800138000', email: 'a@example.com' }] });
  assert.equal(update.updated, 1);
  const list = await customers.list({ keyword: 'Updated' });
  assert.equal(list.total, 1); assert.equal(list.list[0].company, 'Original'); assert.equal(list.list[0].notes, 'keep me');
  assert.equal((await customers.list({ keyword: '100%_' })).total, 1);
  assert.equal((await customers.list({ keyword: "' OR 1=1 --" })).total, 0);
  const simultaneous = await Promise.all([1, 2].map(() => customers.importRows({ ...request, requestId: crypto.randomUUID(), rows: [{ name: 'Concurrent', phone: '13700137000' }] })));
  assert.equal(simultaneous.reduce((n,r) => n+r.inserted,0), 1);
  assert.equal(simultaneous.reduce((n,r) => n+r.skipped,0), 1);
  await assert.rejects(db.withTransaction(async client => { await client.query("INSERT INTO customers(name,phone) VALUES ('Rollback','13600136000')"); throw Error('rollback'); }));
  assert.equal((await customers.list({ keyword: '13600136000' })).total, 0);
  assert.equal((await admin.main({ action: 'customer_list' })).ok, false);
  assert.equal((await admin.main({ action: 'customer_import', ...request })).ok, false);
  const login = await admin.main({ action: 'login', password: require('./require-test-password.cjs')() });
  assert.equal((await admin.main({ action: 'customer_list', token: login.token })).ok, true);
  console.log('PASS: isolated PostgreSQL import, idempotency, concurrent deduplication, update preservation, rollback, search and authentication');
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
