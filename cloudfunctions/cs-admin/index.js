/**
 * cs-admin —— 智能客服管理后台 API（Event Function，CloudBase PostgreSQL 版）
 *
 * 登录：password（须配置环境变量 ADMIN_PASSWORD）→ 返回 token
 * 能力：数据看板 / 对话记录 / 人工坐席回复 / 转人工工单 / 电话随访 / FAQ 管理
 */
const crypto = require('crypto');
const tcb = require('@cloudbase/node-sdk');

const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV });
const db = app.rdb();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TOKEN_SALT = 'cs-admin-static-salt-v1';

function makeToken(password) {
  return crypto.createHash('sha256').update(password + TOKEN_SALT).digest('hex');
}
const VALID_TOKEN = ADMIN_PASSWORD.trim() ? makeToken(ADMIN_PASSWORD) : null;

function authed(event) {
  return !!VALID_TOKEN && event.token === VALID_TOKEN;
}

async function exe(p) {
  const r = await p;
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

function ts(v) {
  return v ? Date.parse(v) || 0 : 0;
}

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

function dayStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ---------------- 看板统计 ---------------- */
async function stats() {
  const [convs, ratings, escalations, calls, msgs] = await Promise.all([
    exe(db.from('conversations').select('*').order('id', { ascending: true }).limit(1000)),
    exe(db.from('satisfaction').select('*').order('id', { ascending: true }).limit(1000)),
    exe(db.from('escalations').select('*').order('id', { ascending: true }).limit(1000)),
    exe(db.from('calls').select('*').order('id', { ascending: true }).limit(1000)),
    exe(db.from('messages').select('*').order('id', { ascending: true }).limit(2000)),
  ]);
  const convList = (convs.data || []).map(mapConversation);
  const ratingList = ratings.data || [];
  const escList = escalations.data || [];
  const callList = (calls.data || []).map(mapCall);
  const msgList = msgs.data || [];

  const today = dayStart(Date.now());
  const intentDist = {};
  convList.forEach((c) => {
    const k = c.intent || 'unknown';
    intentDist[k] = (intentDist[k] || 0) + 1;
  });
  const ratingDist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let ratingSum = 0;
  ratingList.forEach((r) => {
    if (ratingDist[r.rating] !== undefined) ratingDist[r.rating] += 1;
    ratingSum += r.rating || 0;
  });
  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const start = dayStart(Date.now() - i * 86400000);
    const end = start + 86400000;
    daily.push({
      date: new Date(start).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }),
      conversations: convList.filter((c) => c.createdAt >= start && c.createdAt < end).length,
      messages: msgList.filter((m) => ts(m.created_at) >= start && ts(m.created_at) < end).length,
    });
  }
  const resolved = convList.filter((c) => ['resolved', 'closed'].includes(c.status)).length;
  return {
    ok: true,
    totals: {
      conversations: convList.length,
      todayConversations: convList.filter((c) => c.createdAt >= today).length,
      messages: msgList.length,
      escalations: escList.length,
      pendingEscalations: escList.filter((e) => e.status === 'pending').length,
      calls: callList.length,
      completedCalls: callList.filter((c) => ['answered', 'completed'].includes(c.status)).length,
      pendingCalls: callList.filter((c) => c.status === 'pending').length,
      satisfactionCount: ratingList.length,
      satisfactionAvg: ratingList.length ? Number((ratingSum / ratingList.length).toFixed(2)) : null,
    },
    rates: {
      escalationRate: convList.length ? Number((escList.length / convList.length).toFixed(3)) : 0,
      resolveRate: convList.length ? Number((resolved / convList.length).toFixed(3)) : 0,
    },
    intentDist,
    ratingDist,
    daily,
  };
}

/* ---------------- 对话记录 ---------------- */
async function conversations(event) {
  const { status, intent, keyword, page = 1, pageSize = 20 } = event;
  let q = db.from('conversations').select('*');
  if (status) q = q.eq('status', status);
  if (intent) q = q.eq('intent', intent);
  if (keyword) {
    const safe = String(keyword).replace(/[%_]/g, (m) => '\\' + m);
    q = q.ilike('session_id', '%' + safe + '%');
  }
  const countRes = await exe(q.select('*', { count: 'exact', head: true }));
  const total = countRes.count || 0;
  const from = (page - 1) * pageSize;
  const res = await exe(q.range(from, from + pageSize - 1));
  return { ok: true, total, page, pageSize, list: (res.data || []).map(mapConversation) };
}

async function conversationDetail(event) {
  const convRes = await exe(db.from('conversations').select('*').eq('session_id', event.sessionId).limit(1));
  const c = (convRes.data || [])[0];
  if (!c) return { ok: false, error: '会话不存在' };
  const [msgs, escs, calls, rates] = await Promise.all([
    exe(db.from('messages').select('*').eq('session_id', event.sessionId).order('created_at', { ascending: true }).limit(500)),
    exe(db.from('escalations').select('*').eq('session_id', event.sessionId).order('created_at', { ascending: false }).limit(10)),
    exe(db.from('calls').select('*').eq('session_id', event.sessionId).order('created_at', { ascending: false }).limit(10)),
    exe(db.from('satisfaction').select('*').eq('session_id', event.sessionId).order('created_at', { ascending: false }).limit(5)),
  ]);
  return {
    ok: true,
    conversation: mapConversation(c),
    messages: (msgs.data || []).map(mapMessage),
    escalations: (escs.data || []).map(mapEscalation),
    calls: (calls.data || []).map(mapCall),
    ratings: (rates.data || []).map((r) => ({ rating: r.rating, comment: r.comment || '' })),
  };
}

/* ---------------- 人工坐席 ---------------- */
async function agentReply(event) {
  const content = String(event.content || '').trim();
  if (!content) return { ok: false, error: '回复内容不能为空' };
  const convRes = await exe(db.from('conversations').select('*').eq('session_id', event.sessionId).limit(1));
  const c = (convRes.data || [])[0];
  if (!c) return { ok: false, error: '会话不存在' };
  await exe(
    db.from('messages').insert({
      session_id: event.sessionId,
      role: 'agent',
      content: content.slice(0, 1000),
      meta: { agent: '人工坐席' },
    })
  );
  await exe(
    db
      .from('conversations')
      .update({ status: 'escalated', last_message: content.slice(0, 100), updated_at: new Date().toISOString() })
      .eq('id', c.id)
  );
  await exe(
    db.from('escalations').update({ status: 'handling' }).eq('session_id', event.sessionId).eq('status', 'pending')
  );
  return { ok: true };
}

async function escalateResolve(event) {
  const escRes = await exe(db.from('escalations').select('*').eq('session_id', event.sessionId).limit(1));
  const e = (escRes.data || [])[0];
  if (!e) return { ok: false, error: '工单不存在' };
  await exe(db.from('escalations').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', e.id));
  const convRes = await exe(db.from('conversations').select('*').eq('session_id', event.sessionId).limit(1));
  const c = (convRes.data || [])[0];
  if (c) {
    await exe(
      db.from('conversations').update({ status: 'resolved', updated_at: new Date().toISOString() }).eq('id', c.id)
    );
    await exe(
      db.from('messages').insert({
        session_id: event.sessionId,
        role: 'system',
        content: '人工客服已处理完毕，本次服务结束。欢迎对本次服务进行评价 ⭐',
        meta: { type: 'escalation_resolved' },
      })
    );
  }
  return { ok: true };
}

async function escalationsList() {
  const res = await exe(db.from('escalations').select('*').order('created_at', { ascending: false }).limit(100));
  const list = (res.data || []).map(mapEscalation);
  const sessionIds = [...new Set(list.map((e) => e.sessionId))];
  const convMap = {};
  if (sessionIds.length) {
    const convs = await exe(db.from('conversations').select('*').in('session_id', sessionIds).limit(100));
    (convs.data || []).forEach((raw) => {
      const cc = mapConversation(raw);
      convMap[cc.sessionId] = cc;
    });
  }
  return {
    ok: true,
    list: list.map((e) => ({ ...e, conversationStatus: convMap[e.sessionId] ? convMap[e.sessionId].status : null })),
  };
}

/* ---------------- 电话随访 ---------------- */
async function callsList() {
  const res = await exe(db.from('calls').select('*').order('created_at', { ascending: false }).limit(100));
  return { ok: true, list: (res.data || []).map(mapCall) };
}

async function callCreate(event) {
  const phone = String(event.phone || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) return { ok: false, error: '手机号格式不正确' };
  await exe(
    db.from('calls').insert({
      call_id: 'call_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      session_id: event.sessionId || null,
      nickname: event.nickname || '手动任务',
      phone,
      purpose: String(event.purpose || '服务回访').slice(0, 100),
      status: 'pending',
      source: 'admin',
    })
  );
  return { ok: true };
}

/** 管理端立即处理一通电话（转交 cs-call 函数执行真实流程） */
async function callProcessNow(event) {
  try {
    const res = await app.callFunction({ name: 'cs-call', data: { action: 'process_one', callId: event.callId } });
    return res && res.result ? res.result : { ok: false, error: '调用外呼函数失败' };
  } catch (e) {
    return { ok: false, error: '外呼函数不可用：' + ((e && e.message) || e) };
  }
}

/* ---------------- FAQ 管理 ---------------- */
async function faqList() {
  const res = await exe(db.from('faqs').select('*').order('created_at', { ascending: false }).limit(200));
  return { ok: true, list: (res.data || []).map(mapFaq) };
}

async function faqSave(event) {
  const question = String(event.question || '').trim();
  const answer = String(event.answer || '').trim();
  if (!question || !answer) return { ok: false, error: '问题和答案不能为空' };
  const keywords = Array.isArray(event.keywords)
    ? event.keywords.map((k) => String(k).trim()).filter(Boolean)
    : String(event.keywords || '')
        .split(/[,，\s]+/)
        .map((k) => k.trim())
        .filter(Boolean);
  const category = String(event.category || '通用').slice(0, 20);
  if (event.id) {
    await exe(
      db.from('faqs').update({ question, answer, keywords, category }).eq('id', Number(event.id))
    );
    return { ok: true, id: Number(event.id) };
  }
  const faqId = 'F' + Date.now().toString(36).slice(-6).toUpperCase();
  const add = await exe(db.from('faqs').insert({ faq_id: faqId, question, answer, keywords, category }).select());
  const row = (add.data || [])[0];
  return { ok: true, id: row ? row.id : null, faqId };
}

async function faqDelete(event) {
  if (!event.id) return { ok: false, error: '缺少 id' };
  await exe(db.from('faqs').delete().eq('id', Number(event.id)));
  return { ok: true };
}

/* ---------------- 入口（兼容 SDK 直调与 HTTP 网关触发） ---------------- */

function normalizeEvent(raw) {
  if (raw && typeof raw === 'object' && typeof raw.body !== 'undefined') {
    let data = raw.body;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (e) {
        data = null;
      }
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  }
  return raw && typeof raw === 'object' ? raw : {};
}

exports.main = async (rawEvent) => {
  const event = normalizeEvent(rawEvent);
  try {
    if (event.action === 'login') {
      if (!VALID_TOKEN) return { ok: false, error: '请先配置 ADMIN_PASSWORD' };
      if (event.password !== ADMIN_PASSWORD) return { ok: false, error: '密码错误' };
      return { ok: true, token: VALID_TOKEN };
    }
    if (!authed(event)) return { ok: false, error: '未授权，请先登录' };
    switch (event.action) {
      case 'stats':
        return await stats();
      case 'conversations':
        return await conversations(event);
      case 'conversation':
        return await conversationDetail(event);
      case 'agent_reply':
        return await agentReply(event);
      case 'escalate_resolve':
        return await escalateResolve(event);
      case 'escalations':
        return await escalationsList();
      case 'calls':
        return await callsList();
      case 'call_create':
        return await callCreate(event);
      case 'call_process':
        return await callProcessNow(event);
      case 'faq_list':
        return await faqList();
      case 'faq_save':
        return await faqSave(event);
      case 'faq_delete':
        return await faqDelete(event);
      default:
        return { ok: false, error: `未知 action: ${event.action}` };
    }
  } catch (e) {
    console.error('cs-admin error:', e);
    return { ok: false, error: (e && e.message) || '服务内部错误' };
  }
};
