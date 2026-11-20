const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { validateRows } = require('./customer-validation');

async function ensureSchema() {
  const bundled = path.join(__dirname, 'customer-schema.sql');
  await db.q(fs.readFileSync(fs.existsSync(bundled) ? bundled : path.join(__dirname, '../init/03-customers.sql'), 'utf8'));
}

async function list(event) {
  const keyword = String(event.keyword || '').trim().slice(0, 120);
  const page = Math.min(Math.max(parseInt(event.page, 10) || 1, 1), 1000000);
  const term = '%' + keyword.replace(/[\\%_]/g, '\\$&') + '%';
  const where = 'WHERE name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1 OR company ILIKE $1 OR tags ILIKE $1';
  const [rows, count, summary] = await Promise.all([
    db.q(`SELECT * FROM customers ${where} ORDER BY updated_at DESC, id DESC LIMIT 20 OFFSET $2`, [term, (page - 1) * 20]),
    db.q(`SELECT count(*)::int AS total FROM customers ${where}`, [term]),
    db.q("SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')::int AS today, count(*) FILTER (WHERE company <> '')::int AS companies, count(*) FILTER (WHERE tags <> '')::int AS tagged FROM customers")
  ]);
  return { ok: true, list: rows, total: count[0].total, page, pageSize: 20, summary: summary[0] };
}

async function importRows(event) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.requestId || '')) throw new Error('导入请求标识无效，请重新预览');
  if (!['skip', 'update'].includes(event.strategy)) throw new Error('请选择重复客户处理方式');
  const checked = validateRows(event.rows);
  const source = String(event.source || '表格导入').slice(0, 120);
  const hash = crypto.createHash('sha256').update(JSON.stringify({ checked, source, strategy: event.strategy })).digest('hex');
  return db.withTransaction(async client => {
    // Serialize imports so insert/update totals remain correct across concurrent admins.
    await client.query('SELECT pg_advisory_xact_lock(73429311)');
    const previous = await client.query('SELECT * FROM customer_imports WHERE request_id=$1', [event.requestId]);
    if (previous.rows.length) {
      if (previous.rows[0].payload_hash !== hash) throw new Error('导入内容已改变，请重新预览');
      return previous.rows[0].result;
    }
    const result = { ok: true, inserted: 0, updated: 0, skipped: 0, invalid: 0, errors: [] };
    for (const item of checked) {
      if (item.errors.length) {
        result.invalid++;
        result.errors.push({ row: item.row, errors: item.errors });
        continue;
      }
      const c = item.data;
      const params = [c.name, c.phone, c.email, c.company, c.tags, c.notes, source];
      const added = await client.query('INSERT INTO customers (name,phone,email,company,tags,notes,source) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (phone) DO NOTHING RETURNING id', params);
      if (added.rowCount) { result.inserted++; continue; }
      if (event.strategy === 'skip') { result.skipped++; continue; }
      await client.query("UPDATE customers SET name=$1, email=COALESCE(NULLIF($3,''),email), company=COALESCE(NULLIF($4,''),company), tags=COALESCE(NULLIF($5,''),tags), notes=COALESCE(NULLIF($6,''),notes), source=$7, updated_at=now() WHERE phone=$2", params);
      result.updated++;
    }
    await client.query('INSERT INTO customer_imports (request_id,payload_hash,result) VALUES ($1,$2,$3::jsonb)', [event.requestId, hash, JSON.stringify(result)]);
    return result;
  });
}

module.exports = { ensureSchema, list, importRows };
