const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fields, validateRows, guessMapping } = require('../server/customer-validation');
test('Chinese template and English headers map to customer fields', () => {
  assert.deepEqual(guessMapping(fields.map(f => f.label)), { name: 0, phone: 1, email: 2, company: 3, tags: 4, notes: 5 });
  assert.equal(guessMapping(['客户姓名（必填）', 'Mobile', 'Email']).phone, 1);
});
test('normalizes Excel numeric phones and formatted international prefixes', () => {
  const rows = validateRows([{ name: '客户甲', phone: 13800138000 }, { name: '客户乙', phone: '+86 139-0013-8000' }]);
  assert.deepEqual(rows.map(r => r.data.phone), ['13800138000', '13900138000']);
  assert.ok(rows.every(r => !r.errors.length));
});
test('keeps first valid duplicate and reports original spreadsheet row', () => {
  const rows = validateRows([{ row: 8, name: '', phone: '13800138000' }, { row: 12, name: '有效', phone: '13800138000' }, { row: 15, name: '重复', phone: '+86 13800138000' }]);
  assert.ok(rows[0].errors.length);
  assert.equal(rows[1].errors.length, 0);
  assert.match(rows[2].errors.join(), /重复/);
  assert.equal(rows[2].row, 15);
});
test('rejects malformed types, missing names, invalid emails and oversized fields', () => {
  const rows = validateRows([{ name: '客户', phone: '123', email: 'bad' }, { name: {}, phone: '13800138000' }, { name: '长'.repeat(81), phone: '13900138000' }]);
  assert.ok(rows.every(r => r.errors.length > 0));
  assert.throws(() => validateRows([]));
  assert.throws(() => validateRows(Array(2001).fill({})));
});
