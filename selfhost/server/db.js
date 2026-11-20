/**
 * 数据层：CloudBase PG（app.rdb）版的同构移植，直连 PostgreSQL（pg 驱动）。
 * 表结构与云上完全一致（conversations/messages/faqs/orders/escalations/satisfaction/calls）。
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  idleTimeoutMillis: 30000,
});

async function q(sql, params) {
  const r = await pool.query(sql, params || []);
  return r.rows;
}

function ts(v) {
  if (v instanceof Date) return v.getTime();
  return v ? Date.parse(v) || 0 : 0;
}

/* ---------------- 行映射（snake_case → 前端 camelCase） ---------------- */

function mapConversation(c) {
  return {
    id: c.id,
    sessionId: c.session_id,
    nickname: c.nickname,
    status: c.status,
    intent: c.intent,
    flow: c.flow || null,
    missCount: c.miss_count || 0,
    rating: c.rating,
    callRequested: !!c.call_requested,
    lastMessage: c.last_message || '',
    lastOrderId: c.last_order_id || null,
    createdAt: ts(c.created_at),
    updatedAt: ts(c.updated_at),
  };
}

function mapMessage(m) {
  return {
    id: m.id,
    sessionId: m.session_id,
    role: m.role,
    content: m.content,
    meta: m.meta || null,
    createdAt: ts(m.created_at),
  };
}

function mapFaq(f) {
  return {
    id: f.id,
    faqId: f.faq_id,
    question: f.question,
    answer: f.answer,
    keywords: Array.isArray(f.keywords) ? f.keywords : [],
    category: f.category,
    createdAt: ts(f.created_at),
  };
}

function mapOrder(o) {
  return {
    orderId: o.order_id,
    nickname: o.nickname,
    items: o.items,
    amount: Number(o.amount),
    status: o.status,
    logistics: o.logistics,
    refundNo: o.refund_no || null,
    createdAt: ts(o.created_at),
  };
}

function mapEscalation(e) {
  return {
    id: e.id,
    sessionId: e.session_id,
    nickname: e.nickname,
    reason: e.reason,
    status: e.status,
    snapshot: e.conversation_snapshot || '',
    createdAt: ts(e.created_at),
    resolvedAt: ts(e.resolved_at),
  };
}

function mapCall(c) {
  return {
    id: c.id,
    callId: c.call_id,
    sessionId: c.session_id,
    nickname: c.nickname,
    phone: c.phone,
    purpose: c.purpose,
    status: c.status,
    script: c.script || '',
    transcript: c.transcript || '',
    result: c.result || '',
    source: c.source,
    createdAt: ts(c.created_at),
    processedAt: ts(c.processed_at),
  };
}

/* ---------------- conversations ---------------- */

async function getConversationBySession(sessionId) {
  const rows = await q('SELECT * FROM conversations WHERE session_id = $1 LIMIT 1', [sessionId]);
  return rows[0] ? mapConversation(rows[0]) : null;
}

async function insertConversation(sessionId, nickname) {
  const rows = await q(
    'INSERT INTO conversations (session_id, nickname) VALUES ($1, $2) RETURNING *',
    [sessionId, nickname]
  );
  return mapConversation(rows[0]);
}

async function ensureConversation(sessionId, nickname) {
  if (!sessionId) sessionId = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let conv = await getConversationBySession(sessionId);
  if (!conv) conv = await insertConversation(sessionId, nickname || '访客');
  return conv;
}

const CONV_PATCH_KEYS = {
  status: 'status',
  intent: 'intent',
  flow: 'flow',
  missCount: 'miss_count',
  rating: 'rating',
  callRequested: 'call_requested',
  lastMessage: 'last_message',
  lastOrderId: 'last_order_id',
};

async function updateConversation(id, patch) {
  const sets = [];
  const params = [id];
  let i = 2;
  for (const [camel, snake] of Object.entries(CONV_PATCH_KEYS)) {
    if (camel in patch) {
      sets.push(`${snake} = $${i}`);
      params.push(camel === 'flow' ? JSON.stringify(patch[camel] || null) : patch[camel]);
      i += 1;
    }
  }
  sets.push('updated_at = now()');
  await q(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $1`, params);
}

async function listConversations({ status, intent, keyword, limit = 1000, offset = 0, withCount = false }) {
  const where = [];
  const params = [];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (intent) {
    params.push(intent);
    where.push(`intent = $${params.length}`);
  }
  if (keyword) {
    params.push(`%${keyword.replace(/[%_]/g, (m) => '\\' + m)}%`);
    where.push(`session_id ILIKE $${params.length}`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const countRows = withCount
    ? await q(`SELECT count(*)::int AS n FROM conversations ${whereSql}`, params)
    : null;
  const rows = await q(
    `SELECT * FROM conversations ${whereSql} ORDER BY updated_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params
  );
  return {
    list: rows.map(mapConversation),
    total: countRows ? countRows[0].n : null,
  };
}

async function getConversationsBySessions(sessionIds) {
  if (!sessionIds.length) return [];
  const rows = await q('SELECT * FROM conversations WHERE session_id = ANY($1)', [sessionIds]);
  return rows.map(mapConversation);
}

/* ---------------- messages ---------------- */

async function insertMessage({ sessionId, role, content, meta }) {
  const rows = await q(
    'INSERT INTO messages (session_id, role, content, meta) VALUES ($1, $2, $3, $4::jsonb) RETURNING *',
    [sessionId, role, String(content).slice(0, 2000), meta ? JSON.stringify(meta) : null]
  );
  return mapMessage(rows[0]);
}

async function listMessages(sessionId, limit) {
  const rows = await q(
    'SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC LIMIT $2',
    [sessionId, limit]
  );
  return rows.map(mapMessage);
}

async function recentMessages(sessionId, limit) {
  const rows = await q(
    'SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2',
    [sessionId, limit]
  );
  return rows.map(mapMessage).reverse();
}

async function listMessagesSince(sessionId, sinceIso, limit) {
  const rows = await q(
    'SELECT * FROM messages WHERE session_id = $1 AND created_at > $2 ORDER BY created_at ASC LIMIT $3',
    [sessionId, sinceIso, limit]
  );
  return rows.map(mapMessage);
}

/* ---------------- faqs ---------------- */

async function listFaqs(limit) {
  const rows = await q('SELECT * FROM faqs ORDER BY created_at ASC LIMIT $1', [limit || 100]);
  return rows.map(mapFaq);
}

async function listFaqsDesc(limit) {
  const rows = await q('SELECT * FROM faqs ORDER BY created_at DESC LIMIT $1', [limit || 200]);
  return rows.map(mapFaq);
}

async function insertFaq({ faqId, question, answer, keywords, category }) {
  const rows = await q(
    'INSERT INTO faqs (faq_id, question, answer, keywords, category) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *',
    [faqId, question, answer, JSON.stringify(keywords || []), category || '通用']
  );
  return mapFaq(rows[0]);
}

async function updateFaq(id, { question, answer, keywords, category }) {
  await q(
    'UPDATE faqs SET question=$1, answer=$2, keywords=$3::jsonb, category=$4 WHERE id=$5',
    [question, answer, JSON.stringify(keywords || []), category || '通用', id]
  );
}

async function deleteFaq(id) {
  await q('DELETE FROM faqs WHERE id = $1', [id]);
}

/* ---------------- orders ---------------- */

async function getOrder(orderId) {
  const rows = await q('SELECT * FROM orders WHERE order_id = $1 LIMIT 1', [String(orderId).trim()]);
  return rows[0] ? mapOrder(rows[0]) : null;
}

async function updateOrder(orderId, patch) {
  const sets = [];
  const params = [];
  let i = 1;
  for (const k of ['status', 'refund_no']) {
    if (k in patch) {
      sets.push(`${k} = $${i}`);
      params.push(patch[k]);
      i += 1;
    }
  }
  if (!sets.length) return;
  params.push(orderId);
  await q(`UPDATE orders SET ${sets.join(', ')} WHERE order_id = $${i}`, params);
}

/* ---------------- escalations ---------------- */

async function hasActiveEscalation(sessionId) {
  const rows = await q(
    "SELECT id FROM escalations WHERE session_id = $1 AND status IN ('pending','handling') LIMIT 1",
    [sessionId]
  );
  return rows.length > 0;
}

async function insertEscalation(e) {
  await q(
    'INSERT INTO escalations (session_id, nickname, reason, status, conversation_snapshot) VALUES ($1,$2,$3,$4,$5)',
    [e.sessionId, e.nickname, e.reason, 'pending', e.snapshot || '']
  );
}

async function listEscalations(limit) {
  const rows = await q('SELECT * FROM escalations ORDER BY created_at DESC LIMIT $1', [limit || 100]);
  return rows.map(mapEscalation);
}

async function getEscalationBySession(sessionId) {
  const rows = await q('SELECT * FROM escalations WHERE session_id = $1 LIMIT 1', [sessionId]);
  return rows[0] ? mapEscalation(rows[0]) : null;
}

async function resolveEscalation(id) {
  await q("UPDATE escalations SET status='resolved', resolved_at=now() WHERE id=$1", [id]);
}

async function markEscalationsHandling(sessionId) {
  await q("UPDATE escalations SET status='handling' WHERE session_id=$1 AND status='pending'", [sessionId]);
}

/* ---------------- satisfaction ---------------- */

async function insertSatisfaction({ sessionId, rating, comment, intent }) {
  await q(
    'INSERT INTO satisfaction (session_id, rating, comment, intent) VALUES ($1,$2,$3,$4)',
    [sessionId, rating, comment || '', intent || null]
  );
}

async function listSatisfactionBySession(sessionId, limit) {
  const rows = await q(
    'SELECT * FROM satisfaction WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2',
    [sessionId, limit || 5]
  );
  return rows.map((r) => ({ rating: r.rating, comment: r.comment || '' }));
}

async function listSatisfactionAll(limit) {
  return q('SELECT rating FROM satisfaction ORDER BY id LIMIT $1', [limit || 1000]);
}

/* ---------------- calls ---------------- */

async function hasPendingCall(sessionId) {
  const rows = await q(
    "SELECT id FROM calls WHERE session_id = $1 AND status IN ('pending','dialing') LIMIT 1",
    [sessionId]
  );
  return rows.length > 0;
}

async function insertCall(c) {
  await q(
    'INSERT INTO calls (call_id, session_id, nickname, phone, purpose, status, source) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [c.callId, c.sessionId || null, c.nickname || '手动任务', c.phone, c.purpose || '服务回访', 'pending', c.source || 'user_request']
  );
}

async function listCalls(limit) {
  const rows = await q('SELECT * FROM calls ORDER BY created_at DESC LIMIT $1', [limit || 100]);
  return rows.map(mapCall);
}

async function listPendingCalls(limit) {
  const rows = await q("SELECT * FROM calls WHERE status='pending' ORDER BY created_at ASC LIMIT $1", [limit || 5]);
  return rows;
}

async function getCallByCallId(callId) {
  const rows = await q('SELECT * FROM calls WHERE call_id = $1 LIMIT 1', [callId]);
  return rows[0] || null;
}

async function updateCall(id, patch) {
  const map = { status: 'status', script: 'script', transcript: 'transcript', result: 'result' };
  const sets = [];
  const params = [id];
  let i = 2;
  for (const [k, snake] of Object.entries(map)) {
    if (k in patch) {
      sets.push(`${snake} = $${i}`);
      params.push(patch[k]);
      i += 1;
    }
  }
  if ('processedAt' in patch) {
    sets.push('processed_at = now()');
  }
  if (!sets.length) return;
  await q(`UPDATE calls SET ${sets.join(', ')} WHERE id = $1`, params);
}

/* ---------------- 统计辅助（全量拉取，量小直接内存算） ---------------- */

async function statsRaw() {
  const [convs, ratings, escs, calls, msgs] = await Promise.all([
    q('SELECT * FROM conversations ORDER BY id LIMIT 1000'),
    listSatisfactionAll(1000),
    q('SELECT status, created_at FROM escalations ORDER BY id LIMIT 1000'),
    q('SELECT status, created_at FROM calls ORDER BY id LIMIT 1000'),
    q('SELECT created_at FROM messages ORDER BY id LIMIT 2000'),
  ]);
  return { convs, ratings, escs, calls, msgs };
}

module.exports = {
  async withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  },
  q,
  ts,
  mapConversation,
  mapMessage,
  mapFaq,
  mapOrder,
  mapEscalation,
  mapCall,
  ensureConversation,
  getConversationBySession,
  updateConversation,
  listConversations,
  getConversationsBySessions,
  insertMessage,
  listMessages,
  recentMessages,
  listMessagesSince,
  listFaqs,
  listFaqsDesc,
  insertFaq,
  updateFaq,
  deleteFaq,
  getOrder,
  updateOrder,
  hasActiveEscalation,
  insertEscalation,
  listEscalations,
  getEscalationBySession,
  resolveEscalation,
  markEscalationsHandling,
  insertSatisfaction,
  listSatisfactionBySession,
  insertCall,
  listCalls,
  listPendingCalls,
  getCallByCallId,
  updateCall,
  statsRaw,
};
