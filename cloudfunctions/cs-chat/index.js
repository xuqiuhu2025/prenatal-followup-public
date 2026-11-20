/**
 * cs-chat —— 智能客服 Agent 核心对话函数（Event Function，CloudBase PostgreSQL 版）
 *
 * 能力：
 *  1. 多轮对话 + 上下文连贯（历史存 PG messages 表）
 *  2. FAQ 知识库语义检索（LLM 相关性筛选 + 兜底词面检索）
 *  3. 意图识别与路由：refund 退款 / order_query 订单查询 / tech_support 技术支持 / faq / chitchat / escalate 转人工
 *  4. 无法解决时自动转接人工客服（写入 escalations，管理后台跟进）
 *  5. 满意度评价（satisfaction）
 *  6. 电话随访预约（写入 calls，由 cs-call 定时函数自动外呼）
 *  7. 大模型驱动对话生成（失败时降级为模板回复保证可用）
 */
const tcb = require('@cloudbase/node-sdk');

const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV });
const db = app.rdb();

const AI_MODEL_ID = process.env.AI_MODEL_ID || 'hy3-preview';
const AI_GROUP = process.env.AI_GROUP || 'hunyuan-v3'; // DescribeAIModels 返回且已启用的分组
const HISTORY_WINDOW = 10; // 送入 LLM 的最近历史条数
const MISS_LIMIT = 2; // 连续无法解决次数，超过自动转人工

const ROUTE_LABEL = {
  refund: '退款流程',
  order_query: '订单查询',
  tech_support: '技术支持',
  faq: 'FAQ 知识库',
  chitchat: '智能问答',
  escalate: '人工客服',
};

/* ------------------------------------------------------------------ *
 *  基础工具
 * ------------------------------------------------------------------ */

function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function clampText(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) : s;
}

async function exe(p) {
  const r = await p;
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

/** 词面重合度打分（无 LLM 时的 FAQ 兜底检索） */
function lexicalScore(query, faq) {
  const q = (query || '').toLowerCase();
  let score = 0;
  (faq.keywords || []).forEach((k) => {
    if (k && q.includes(String(k).toLowerCase())) score += 2;
  });
  const words = String(faq.question || '').toLowerCase().split(/[\s,，?？.。!！]+/).filter((w) => w.length > 1);
  words.forEach((w) => {
    if (q.includes(w)) score += 1;
  });
  return score;
}

/* ------------------------------------------------------------------ *
 *  LLM 封装（失败自动降级）
 * ------------------------------------------------------------------ */

let aiModel = null;
function getAi() {
  if (!process.env.AI_DISABLED) {
    try {
      if (!aiModel) aiModel = app.ai().createModel(AI_GROUP);
      return aiModel;
    } catch (e) {
      console.warn('AI init failed, fallback to templates:', (e && e.message) || e);
      return null;
    }
  }
  return null;
}

/** 生成文本；AI 不可用时返回 null */
async function llmText(messages, { temperature = 0.4 } = {}) {
  const ai = getAi();
  if (!ai) return null;
  try {
    const result = await ai.generateText({ model: AI_MODEL_ID, messages, temperature });
    if (result && typeof result.text === 'string' && result.text.trim()) return result.text.trim();
  } catch (e) {
    console.warn('AI generateText failed:', (e && e.message) || e);
  }
  return null;
}

/** 从 LLM 输出中解析 JSON（容忍 ```json 包裹） */
function parseJsonLoose(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 *  数据访问（CloudBase PG，服务端身份绕过 RLS；表对浏览器默认拒绝）
 * ------------------------------------------------------------------ */

async function loadFaqs() {
  const r = await exe(db.from('faqs').select('*').order('created_at', { ascending: true }).limit(100));
  return (r.data || []).map(mapFaq);
}

function mapFaq(f) {
  return {
    id: f.id,
    faqId: f.faq_id,
    question: f.question,
    answer: f.answer,
    keywords: Array.isArray(f.keywords) ? f.keywords : [],
    category: f.category,
    createdAt: Date.parse(f.created_at) || 0,
  };
}

async function loadOrder(orderId) {
  if (!orderId) return null;
  const r = await exe(db.from('orders').select('*').eq('order_id', String(orderId).trim()).limit(1));
  const o = (r.data || [])[0];
  if (!o) return null;
  return {
    orderId: o.order_id,
    nickname: o.nickname,
    items: o.items,
    amount: Number(o.amount),
    status: o.status,
    logistics: o.logistics,
    createdAt: Date.parse(o.created_at) || 0,
  };
}

async function ensureConversation(sessionId, nickname) {
  if (!sessionId) sessionId = newId('s');
  const found = await exe(db.from('conversations').select('*').eq('session_id', sessionId).limit(1));
  let conv = (found.data || [])[0];
  if (!conv) {
    const inserted = await exe(
      db.from('conversations').insert({ session_id: sessionId, nickname: clampText(nickname || '访客', 20) }).select()
    );
    conv = (inserted.data || [])[0];
    if (!conv) {
      const again = await exe(db.from('conversations').select('*').eq('session_id', sessionId).limit(1));
      conv = (again.data || [])[0];
    }
  }
  return mapConversation(conv);
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
    createdAt: Date.parse(c.created_at) || 0,
    updatedAt: Date.parse(c.updated_at) || 0,
  };
}

function convPatch(patch) {
  const p = { updated_at: new Date().toISOString() };
  if ('status' in patch) p.status = patch.status;
  if ('intent' in patch) p.intent = patch.intent;
  if ('flow' in patch) p.flow = patch.flow;
  if ('missCount' in patch) p.miss_count = patch.missCount;
  if ('rating' in patch) p.rating = patch.rating;
  if ('callRequested' in patch) p.call_requested = patch.callRequested;
  if ('lastMessage' in patch) p.last_message = patch.lastMessage;
  if ('lastOrderId' in patch) p.last_order_id = patch.lastOrderId;
  return p;
}

async function updateConversation(convId, patch) {
  await exe(db.from('conversations').update(convPatch(patch)).eq('id', convId));
}

function mapMessage(m) {
  return {
    id: m.id,
    sessionId: m.session_id,
    role: m.role,
    content: m.content,
    meta: m.meta || null,
    createdAt: Date.parse(m.created_at) || 0,
  };
}

async function saveMessage(sessionId, role, content, meta) {
  const r = await exe(
    db
      .from('messages')
      .insert({ session_id: sessionId, role, content: clampText(content, 2000), meta: meta || null })
      .select()
  );
  const row = (r.data || [])[0];
  return mapMessage(row || { session_id: sessionId, role, content, meta, created_at: new Date().toISOString() });
}

async function recentMessages(sessionId, limit) {
  const r = await exe(
    db
      .from('messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(limit || HISTORY_WINDOW)
  );
  return (r.data || []).map(mapMessage).reverse();
}

/* ------------------------------------------------------------------ *
 *  第一步：意图分析（LLM，失败降级关键词规则）
 * ------------------------------------------------------------------ */

const INTENTS = ['refund', 'order_query', 'tech_support', 'faq', 'chitchat', 'escalate'];

async function analyzeIntent(userText, history, faqs, conv) {
  const ai = getAi();
  if (ai) {
    const faqIndex = faqs
      .slice(0, 60)
      .map((f) => `#${f.faqId || f.id} ${f.question}`)
      .join('\n');
    const sys = [
      '你是电商客服系统的意图分析引擎。只输出一个 JSON 对象，不要输出任何其他文字。',
      '字段定义：',
      'intent: "refund"(退款退货退款申请) | "order_query"(订单/物流/快递进度查询) | "tech_support"(产品故障/技术问题) | "faq"(常见问题咨询) | "chitchat"(寒暄闲聊) | "escalate"(用户明确要求人工/投诉/情绪激动)',
      'confidence: 0到1的数字',
      'sentiment: "positive" | "neutral" | "angry"',
      'faqIds: 与用户问题最相关的FAQ编号数组(最多3个，来自下方FAQ索引，无相关则空数组)',
      'orderId: 用户消息中提到的订单号(如 SO10001 这类编号，没有则 null)',
      'wantsHuman: 布尔值，用户是否明确要求人工客服',
    ].join('\n');
    const hist = history
      .slice(-6)
      .map((m) => `${m.role === 'user' ? '用户' : m.role === 'assistant' ? '客服' : '人工'}: ${m.content}`)
      .join('\n');
    const usr = [
      '【FAQ索引】',
      faqIndex || '(空)',
      '【当前退款流程状态】',
      conv.flow ? JSON.stringify(conv.flow) : '无',
      '【最近对话】',
      hist || '(无)',
      '【用户最新消息】',
      userText,
    ].join('\n');
    const out = await llmText(
      [
        { role: 'system', content: sys },
        { role: 'user', content: usr },
      ],
      { temperature: 0.1 }
    );
    const parsed = parseJsonLoose(out);
    if (parsed && INTENTS.includes(parsed.intent)) {
      return {
        intent: parsed.intent,
        confidence: typeof parsed.confidence === 'number' ? Math.min(Math.max(parsed.confidence, 0), 1) : 0.6,
        sentiment: ['positive', 'neutral', 'angry'].includes(parsed.sentiment) ? parsed.sentiment : 'neutral',
        faqIds: Array.isArray(parsed.faqIds) ? parsed.faqIds.slice(0, 3).map(String) : [],
        orderId: parsed.orderId ? String(parsed.orderId) : null,
        wantsHuman: !!parsed.wantsHuman,
        source: 'llm',
      };
    }
  }
  return analyzeByKeyword(userText, faqs);
}

function analyzeByKeyword(userText, faqs) {
  const t = (userText || '').toLowerCase();
  const has = (arr) => arr.some((k) => t.includes(k));
  let intent = 'chitchat';
  if (has(['人工', '投诉', '转接', '真人', '客服人员'])) intent = 'escalate';
  else if (has(['退款', '退钱', '退货', '退单', '取消订单'])) intent = 'refund';
  else if (has(['订单', '快递', '物流', '到哪', '发货', '签收', '单号'])) intent = 'order_query';
  else if (has(['故障', '报错', '无法', '打不开', '崩溃', '技术', 'bug', '卡死', '连不上'])) intent = 'tech_support';
  else if (faqs && faqs.some((f) => lexicalScore(t, f) > 0)) intent = 'faq';

  const m = (userText || '').match(/SO\d{4,10}/i);
  const scored = (faqs || [])
    .map((f) => ({ f, s: lexicalScore(t, f) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  return {
    intent,
    confidence: intent === 'chitchat' ? 0.4 : 0.55,
    sentiment: has(['气死', '垃圾', '骗', '差评', '太慢', '坑']) ? 'angry' : 'neutral',
    faqIds: scored.map((x) => String(x.f.faqId || x.f.id)),
    orderId: m ? m[0].toUpperCase() : null,
    wantsHuman: intent === 'escalate',
    source: 'rule',
  };
}

/* ------------------------------------------------------------------ *
 *  第二步：按意图路由处理，产出回复资料
 * ------------------------------------------------------------------ */

function pickFaqs(faqs, analysis, userText) {
  const byId = {};
  faqs.forEach((f) => {
    byId[String(f.faqId || f.id)] = f;
  });
  let picked = (analysis.faqIds || []).map((id) => byId[id]).filter(Boolean);
  if (!picked.length) {
    picked = faqs
      .map((f) => ({ f, s: lexicalScore(userText, f) }))
      .sort((a, b) => b.s - a.s)
      .filter((x) => x.s > 0)
      .slice(0, 3)
      .map((x) => x.f);
  }
  return picked;
}

/** 退款流程状态机 */
async function handleRefund(conv, userText, analysis) {
  let flow = conv.flow && conv.flow.type === 'refund' ? conv.flow : { type: 'refund', stage: 'ask_order', orderId: null, reason: null };
  let resolved = false;
  let done = false;
  let material = '';

  if (flow.stage === 'ask_order') {
    const oid = analysis.orderId || (userText.match(/SO\d{4,10}/i) || [])[0];
    if (oid) {
      const order = await loadOrder(oid);
      if (order) {
        flow.orderId = order.orderId;
        flow.order = { amount: order.amount, status: order.status, items: order.items };
        flow.stage = 'ask_reason';
        material = `用户订单已核实：${order.orderId}，商品：${order.items}，金额：${order.amount} 元，订单状态：${order.status}。请向用户确认订单信息，并请用户说明退款原因（质量问题/不想要了/未收到货/其他）。`;
      } else {
        material = `用户提供的订单号 ${oid} 未查到。请请用户核对订单号（示例格式 SO10001），或提示转人工处理。`;
        flow = { type: 'refund', stage: 'ask_order', orderId: null, reason: null };
      }
    } else {
      material = '用户想申请退款。请友好地请用户提供订单号（例如 SO10001）。';
    }
  } else if (flow.stage === 'ask_reason') {
    flow.reason = clampText(userText, 100);
    flow.stage = 'confirm';
    material = `用户订单 ${flow.orderId}（${flow.order ? flow.order.items : ''}，${flow.order ? flow.order.amount : ''} 元），退款原因：${flow.reason}。请向用户复述退款信息并询问是否确认提交退款申请。`;
  } else if (flow.stage === 'confirm') {
    if (/确认|确定|是的|是的|没问题|可以|提交|ok|OK/i.test(userText)) {
      flow.stage = 'done';
      done = true;
      resolved = true;
      const refundNo = 'RF' + Date.now().toString().slice(-8);
      flow.refundNo = refundNo;
      await exe(db.from('orders').update({ status: '退款处理中', refund_no: refundNo }).eq('order_id', flow.orderId));
      material = `退款申请已受理：退款单号 ${refundNo}，订单 ${flow.orderId}，预计 1-3 个工作日原路退回。请告知用户退款已提交成功，并主动询问是否需要预约电话随访了解后续进度。`;
    } else {
      flow = { type: 'refund', stage: 'ask_reason', orderId: flow.orderId, reason: null };
      material = '用户对退款信息有修改。请重新请用户说明退款原因。';
    }
  }
  return { flow, material, resolved, done };
}

/** 订单查询 */
async function handleOrderQuery(conv, userText, analysis) {
  const oid = analysis.orderId || (userText.match(/SO\d{4,10}/i) || [])[0] || conv.lastOrderId || null;
  if (oid) {
    const order = await loadOrder(oid);
    if (order) {
      const detail = [
        `订单号：${order.orderId}`,
        `商品：${order.items}`,
        `金额：${order.amount} 元`,
        `状态：${order.status}`,
        order.logistics ? `物流：${order.logistics}` : '',
        `下单时间：${new Date(order.createdAt).toLocaleString('zh-CN')}`,
      ]
        .filter(Boolean)
        .join('；');
      return {
        material: `已查询到订单信息（请用自然语言转述给用户，可分条列出）：${detail}`,
        resolved: true,
        lastOrderId: order.orderId,
      };
    }
    return {
      material: `订单号 ${oid} 未查到，请提醒用户核对订单号（示例 SO10001）；若用户没有订单号可提示其查看购买短信或订单页。`,
      resolved: false,
    };
  }
  return { material: '用户想查询订单，但还没有提供订单号。请请用户提供订单号（例如 SO10001）。', resolved: false };
}

/* ------------------------------------------------------------------ *
 *  第三步：LLM 生成自然回复（失败降级模板）
 * ------------------------------------------------------------------ */

const PERSONA = [
  '你是「小智」，云舟优选电商平台的智能客服助手，礼貌、专业、简洁，每次回复不超过 120 字，使用中文。',
  '规则：',
  '1. 只依据【资料】中的内容回答，不要编造事实；资料为空时如实说明并给出下一步建议。',
  '2. 若资料显示需要转人工，明确告知用户已转接人工客服，人工坐席会尽快接入。',
  '3. 不讨论与客服无关的话题，礼貌引导回业务问题。',
].join('\n');

async function generateReply(userText, history, material, routeLabel) {
  const hist = history
    .slice(-HISTORY_WINDOW)
    .map((m) => `${m.role === 'user' ? '用户' : '客服'}: ${clampText(m.content, 300)}`)
    .join('\n');
  return llmText(
    [
      { role: 'system', content: PERSONA },
      {
        role: 'user',
        content: `【资料】\n${material || '(无)'}\n\n【当前路由】${routeLabel}\n\n【最近对话】\n${hist || '(无)'}\n\n【用户最新消息】\n${userText}\n\n请直接输出回复用户的文字，不要任何前缀说明。`,
      },
    ],
    { temperature: 0.5 }
  );
}

/* ------------------------------------------------------------------ *
 *  转人工
 * ------------------------------------------------------------------ */

async function escalate(conv, reason, userText) {
  const exist = await exe(
    db.from('escalations').select('id').eq('session_id', conv.sessionId).in('status', ['pending', 'handling']).limit(1)
  );
  if (!(exist.data || []).length) {
    await exe(
      db.from('escalations').insert({
        session_id: conv.sessionId,
        nickname: conv.nickname,
        reason: clampText(reason || userText || '用户请求人工服务', 200),
        status: 'pending',
        conversation_snapshot: clampText(conv.lastMessage, 200),
      })
    );
  }
  await updateConversation(conv.id, { status: 'escalated', missCount: 0 });
  return {
    reply:
      '已为您转接人工客服，人工坐席正在赶来的路上，请稍候片刻。您也可以点击下方「预约电话回访」留下电话，我们会主动与您联系。给您带来不便深表歉意 🙏',
    route: 'escalate',
  };
}

/* ------------------------------------------------------------------ *
 *  主对话流程
 * ------------------------------------------------------------------ */

async function handleChat(event) {
  const sessionId = event.sessionId;
  const userText = clampText(event.message || '', 1000);
  if (!userText) return { ok: false, error: '消息不能为空' };

  const conv = await ensureConversation(sessionId, event.nickname);
  const faqs = await loadFaqs();
  const history = await recentMessages(conv.sessionId, HISTORY_WINDOW);

  // 人工接管中：仅记录用户消息并透传提示（人工客服在后台回复）
  if (conv.status === 'escalated') {
    await saveMessage(conv.sessionId, 'user', userText, { intent: 'escalated_passthrough' });
    await updateConversation(conv.id, { lastMessage: userText, intent: 'escalate' });
    return {
      ok: true,
      reply: '人工客服正在接入中，您的消息已同步给坐席，请稍候。',
      intent: 'escalate',
      confidence: 1,
      route: 'escalate',
    };
  }

  await saveMessage(conv.sessionId, 'user', userText, null);

  // 1. 意图识别
  const analysis = await analyzeIntent(userText, history, faqs, conv);
  const intent = analysis.intent;

  // 情绪激动 → 直接转人工
  if (analysis.sentiment === 'angry' && intent !== 'escalate') {
    await escalate(conv, `检测到用户负面情绪（消息：${userText.slice(0, 50)}）`, userText);
    await saveMessage(conv.sessionId, 'assistant', ESCALATE_REPLY, { intent, confidence: analysis.confidence, route: 'escalate' });
    await updateConversation(conv.id, { lastMessage: ESCALATE_REPLY, intent });
    return okReply(ESCALATE_REPLY, intent, analysis.confidence, 'escalate', ['request_call']);
  }

  // 2. 路由
  let material = '';
  let route = intent;
  let resolved = false;
  let flowPatch = null;
  let lastOrderId = null;
  const actions = [];
  let escalated = false;

  if (intent === 'escalate' || analysis.wantsHuman) {
    await escalate(conv, '用户要求人工客服', userText);
    escalated = true;
    route = 'escalate';
  } else if (intent === 'refund') {
    const r = await handleRefund(conv, userText, analysis);
    flowPatch = r.flow;
    material = r.material;
    resolved = r.resolved;
    route = 'refund';
    if (r.done) actions.push('request_call', 'rate');
  } else if (intent === 'order_query') {
    const r = await handleOrderQuery(conv, userText, analysis);
    material = r.material;
    resolved = r.resolved;
    lastOrderId = r.lastOrderId || null;
    route = 'order_query';
    if (r.resolved) actions.push('rate');
  } else if (intent === 'tech_support' || intent === 'faq' || intent === 'chitchat') {
    const picked = pickFaqs(faqs, analysis, userText);
    if (picked.length) {
      material = '【FAQ 知识库检索结果】\n' + picked.map((f) => `问：${f.question}\n答：${f.answer}`).join('\n\n');
      resolved = true;
      route = intent === 'tech_support' ? 'tech_support' : 'faq';
    } else if (intent === 'tech_support') {
      material = '';
    } else {
      material = '';
    }
  }

  // 3. 连续无法解决 → 自动转人工
  let missCount = conv.missCount || 0;
  if (!resolved && !material && route !== 'escalate') {
    missCount += 1;
  } else {
    missCount = 0;
  }
  if (missCount >= MISS_LIMIT && route !== 'escalate') {
    await escalate(conv, `智能客服连续 ${missCount} 次未能解决问题（意图：${intent}）`, userText);
    escalated = true;
    route = 'escalate';
  }

  // 4. 生成回复
  let reply;
  if (escalated) {
    reply = ESCALATE_REPLY;
    actions.length = 0;
    actions.push('request_call');
    missCount = 0;
  } else {
    const fallback =
      material ||
      (intent === 'chitchat'
        ? '您好，我是云舟优选智能客服小智 🤖 可以帮您：查询订单、办理退款、解答产品与技术问题。请问有什么可以帮您？'
        : '抱歉，这个问题我暂时无法解答。您可以换个问法，或回复「转人工」由人工客服为您服务。');
    reply = (await generateReply(userText, history, material, ROUTE_LABEL[route] || route)) || fallback;
  }

  // 5. 持久化
  await saveMessage(conv.sessionId, 'assistant', reply, {
    intent,
    confidence: analysis.confidence,
    route,
    ai: analysis.source,
  });
  const patch = {
    lastMessage: clampText(reply, 100),
    intent,
    missCount,
    lastOrderId: lastOrderId || conv.lastOrderId || null,
  };
  if (flowPatch) patch.flow = flowPatch;
  if (resolved && route !== 'escalate') patch.status = 'resolved';
  await updateConversation(conv.id, patch);

  return okReply(reply, intent, analysis.confidence, route, conv.id, actions);
}

const ESCALATE_REPLY =
  '已为您转接人工客服，人工坐席正在赶来的路上，请稍候片刻。您也可以点击下方「预约电话回访」留下电话，我们会主动与您联系。给您带来不便深表歉意 🙏';

function okReply(reply, intent, confidence, route, convId, actions) {
  return {
    ok: true,
    reply,
    intent,
    confidence,
    route,
    actions: actions || [],
    conversationId: convId,
  };
}

/* ------------------------------------------------------------------ *
 *  其他 action：历史 / 评价 / 电话预约 / 轮询
 * ------------------------------------------------------------------ */

async function handleStart(event) {
  const conv = await ensureConversation(event.sessionId, event.nickname);
  const r = await exe(
    db.from('messages').select('*').eq('session_id', conv.sessionId).order('created_at', { ascending: true }).limit(200)
  );
  let list = (r.data || []).map(mapMessage);
  if (!list.length) {
    const welcome =
      '您好，欢迎来到云舟优选智能客服，我是 AI 助手小智 🤖\n我可以帮您：\n1️⃣ 查询订单与物流\n2️⃣ 办理退款/退货\n3️⃣ 解答产品与技术问题\n请问有什么可以帮您？您也可以点击下方快捷按钮直接开始。';
    const saved = await saveMessage(conv.sessionId, 'assistant', welcome, { intent: 'welcome', route: 'welcome' });
    await updateConversation(conv.id, { lastMessage: welcome });
    list = [saved];
  }
  return { ok: true, sessionId: conv.sessionId, status: conv.status, messages: list };
}

async function handleHistory(event) {
  const r = await exe(
    db.from('messages').select('*').eq('session_id', event.sessionId).order('created_at', { ascending: true }).limit(200)
  );
  const conv = await exe(db.from('conversations').select('*').eq('session_id', event.sessionId).limit(1));
  const c = (conv.data || [])[0];
  return {
    ok: true,
    status: c ? c.status : 'open',
    rating: c ? c.rating : null,
    messages: (r.data || []).map(mapMessage),
  };
}

async function handleRate(event) {
  const rating = Math.round(Number(event.rating));
  if (!(rating >= 1 && rating <= 5)) return { ok: false, error: '评分需为 1-5' };
  const conv = await exe(db.from('conversations').select('*').eq('session_id', event.sessionId).limit(1));
  const c = (conv.data || [])[0];
  if (!c) return { ok: false, error: '会话不存在' };
  await exe(
    db.from('satisfaction').insert({
      session_id: event.sessionId,
      rating,
      comment: clampText(event.comment || '', 300),
      intent: c.intent || null,
    })
  );
  await updateConversation(c.id, { rating, status: c.status === 'escalated' ? 'escalated' : 'closed' });
  await saveMessage(event.sessionId, 'system', `用户完成满意度评价：${'⭐'.repeat(rating)}（${rating}/5 分）`, { type: 'rating' });
  return { ok: true };
}

/** 预约电话随访（写入 calls，cs-call 定时函数自动外呼） */
async function handleRequestCall(event) {
  const phone = String(event.phone || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) return { ok: false, error: '请输入正确的 11 位手机号' };
  const convRes = await exe(db.from('conversations').select('*').eq('session_id', event.sessionId).limit(1));
  const c = (convRes.data || [])[0];
  if (!c) return { ok: false, error: '会话不存在' };
  const dup = await exe(
    db.from('calls').select('id').eq('session_id', event.sessionId).in('status', ['pending', 'dialing']).limit(1)
  );
  if ((dup.data || []).length) return { ok: true, message: '您已有一通随访电话排队中，我们会尽快与您联系。' };
  await exe(
    db.from('calls').insert({
      call_id: newId('call'),
      session_id: event.sessionId,
      nickname: c.nickname,
      phone,
      purpose: clampText(event.purpose || '服务回访：了解问题处理进度与满意度', 100),
      status: 'pending',
      source: 'user_request',
    })
  );
  await updateConversation(c.id, { callRequested: true });
  await saveMessage(event.sessionId, 'system', `📞 已登记电话随访请求（${phone}），系统将自动外呼，请保持手机畅通。`, { type: 'call' });
  return { ok: true, message: '电话随访已登记，系统将自动外呼，请保持手机畅通。' };
}

/** 转人工后轮询新消息（人工坐席回复 / 系统通知） */
async function handlePoll(event) {
  const since = Number(event.since || 0);
  const sinceIso = since > 0 ? new Date(since).toISOString() : new Date(0).toISOString();
  const r = await exe(
    db
      .from('messages')
      .select('*')
      .eq('session_id', event.sessionId)
      .gt('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .limit(50)
  );
  const conv = await exe(db.from('conversations').select('*').eq('session_id', event.sessionId).limit(1));
  const c = (conv.data || [])[0];
  return {
    ok: true,
    status: c ? c.status : 'open',
    rating: c ? c.rating : null,
    messages: (r.data || []).map(mapMessage),
  };
}

/* ------------------------------------------------------------------ *
 *  入口（兼容 SDK 直调与 HTTP 网关触发：网关会把 body 包在 event.body）
 * ------------------------------------------------------------------ */

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
    switch (event.action) {
      case 'start':
        return await handleStart(event);
      case 'chat':
        return await handleChat(event);
      case 'history':
        return await handleHistory(event);
      case 'rate':
        return await handleRate(event);
      case 'request_call':
        return await handleRequestCall(event);
      case 'poll':
        return await handlePoll(event);
      default:
        return { ok: false, error: `未知 action: ${event.action}` };
    }
  } catch (e) {
    console.error('cs-chat error:', e);
    return { ok: false, error: (e && e.message) || '服务内部错误' };
  }
};
