/**
 * 智能客服 Agent 核心对话逻辑（自托管版，与云函数版同构）：
 * 意图识别（LLM→规则兜底）→ 按意图路由 → FAQ 检索 → LLM 生成 → 自动转人工 → 评价 → 电话预约
 */
const db = require('./db');
const llm = require('./llm');

const HISTORY_WINDOW = 10;
const MISS_LIMIT = 2;

const ROUTE_LABEL = {
  refund: '退款流程',
  order_query: '订单查询',
  tech_support: '技术支持',
  faq: 'FAQ 知识库',
  chitchat: '智能问答',
  escalate: '人工客服',
};

const INTENTS = ['refund', 'order_query', 'tech_support', 'faq', 'chitchat', 'escalate'];

function clampText(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) : s;
}

function lexicalScore(query, faq) {
  const q = (query || '').toLowerCase();
  let score = 0;
  (faq.keywords || []).forEach((k) => {
    if (k && q.includes(String(k).toLowerCase())) score += 2;
  });
  String(faq.question || '')
    .toLowerCase()
    .split(/[\s,，?？.。!！]+/)
    .filter((w) => w.length > 1)
    .forEach((w) => {
      if (q.includes(w)) score += 1;
    });
  return score;
}

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

/* ---------------- 意图分析 ---------------- */

async function analyzeIntent(userText, history, faqs, conv, voiceModel) {
  if (llm.enabled()) {
    const faqIndex = faqs
      .slice(0, 60)
      .map((f) => `#${f.faqId || f.id} ${f.question}`)
      .join('\n');
    const sys = [
      '你是电商客服系统的意图分析引擎。只输出一个 JSON 对象，不要输出任何其他文字，不要思考过程。',
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
    const out = await llm.chat(
      [
        { role: 'system', content: sys },
        {
          role: 'user',
          content: [
            '【FAQ索引】', faqIndex || '(空)',
            '【当前退款流程状态】', conv.flow ? JSON.stringify(conv.flow) : '无',
            '【最近对话】', hist || '(无)',
            '【用户最新消息】', userText,
          ].join('\n'),
        },
      ],
      { temperature: 0.1, maxTokens: 1024, model: voiceModel }
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

/* ---------------- 退款状态机 ---------------- */

async function handleRefund(conv, userText, analysis) {
  let flow = conv.flow && conv.flow.type === 'refund' ? conv.flow : { type: 'refund', stage: 'ask_order', orderId: null, reason: null };
  let resolved = false;
  let done = false;
  let material = '';

  if (flow.stage === 'ask_order') {
    const oid = analysis.orderId || (userText.match(/SO\d{4,10}/i) || [])[0];
    if (oid) {
      const order = await db.getOrder(oid);
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
    if (/确认|确定|是的|没问题|可以|提交|ok|OK/i.test(userText)) {
      flow.stage = 'done';
      done = true;
      resolved = true;
      const refundNo = 'RF' + Date.now().toString().slice(-8);
      flow.refundNo = refundNo;
      await db.updateOrder(flow.orderId, { status: '退款处理中', refund_no: refundNo });
      material = `退款申请已受理：退款单号 ${refundNo}，订单 ${flow.orderId}，预计 1-3 个工作日原路退回。请告知用户退款已提交成功，并主动询问是否需要预约电话随访了解后续进度。`;
    } else {
      flow = { type: 'refund', stage: 'ask_reason', orderId: flow.orderId, reason: null };
      material = '用户对退款信息有修改。请重新请用户说明退款原因。';
    }
  }
  return { flow, material, resolved, done };
}

async function handleOrderQuery(conv, userText, analysis) {
  const oid = analysis.orderId || (userText.match(/SO\d{4,10}/i) || [])[0] || conv.lastOrderId || null;
  if (oid) {
    const order = await db.getOrder(oid);
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
      return { material: `已查询到订单信息（请用自然语言转述给用户，可分条列出）：${detail}`, resolved: true, lastOrderId: order.orderId };
    }
    return { material: `订单号 ${oid} 未查到，请提醒用户核对订单号（示例 SO10001）；若用户没有订单号可提示其查看购买短信或订单页。`, resolved: false };
  }
  return { material: '用户想查询订单，但还没有提供订单号。请请用户提供订单号（例如 SO10001）。', resolved: false };
}

/* ---------------- 回复生成 ---------------- */

const PERSONA = [
  '你是「小智」，云舟优选电商平台的智能客服助手，礼貌、专业、简洁，每次回复不超过 120 字，使用中文，直接输出回复内容。',
  '规则：',
  '1. 只依据【资料】中的内容回答，不要编造事实；资料为空时如实说明并给出下一步建议。',
  '2. 若资料显示需要转人工，明确告知用户已转接人工客服，人工坐席会尽快接入。',
  '3. 不讨论与客服无关的话题，礼貌引导回业务问题。',
].join('\n');

async function generateReply(userText, history, material, routeLabel, voiceModel) {
  const hist = history
    .slice(-HISTORY_WINDOW)
    .map((m) => `${m.role === 'user' ? '用户' : '客服'}: ${clampText(m.content, 300)}`)
    .join('\n');
  return llm.chat(
    [
      { role: 'system', content: PERSONA },
      {
        role: 'user',
        content: `【资料】\n${material || '(无)'}\n\n【当前路由】${routeLabel}\n\n【最近对话】\n${hist || '(无)'}\n\n【用户最新消息】\n${userText}\n\n请直接输出回复用户的文字，不要任何前缀说明。`,
      },
    ],
    { temperature: 0.5, maxTokens: 2048, model: voiceModel }
  );
}

/* ---------------- 转人工 ---------------- */

const ESCALATE_REPLY =
  '已为您转接人工客服，人工坐席正在赶来的路上，请稍候片刻。您也可以点击下方「预约电话回访」留下电话，我们会主动与您联系。给您带来不便深表歉意 🙏';

async function escalate(conv, reason, userText) {
  if (!(await db.hasActiveEscalation(conv.sessionId))) {
    await db.insertEscalation({
      sessionId: conv.sessionId,
      nickname: conv.nickname,
      reason: clampText(reason || userText || '用户请求人工服务', 200),
      snapshot: clampText(conv.lastMessage, 200),
    });
  }
  await db.updateConversation(conv.id, { status: 'escalated', missCount: 0 });
}

/* ---------------- 主流程 ---------------- */

async function handleChat(event, voiceModel) {
  const sessionId = event.sessionId;
  const userText = clampText(event.message || '', 1000);
  if (!userText) return { ok: false, error: '消息不能为空' };

  const conv = await db.ensureConversation(sessionId, event.nickname);
  const faqs = await db.listFaqs(100);
  const history = await db.recentMessages(conv.sessionId, HISTORY_WINDOW);

  if (conv.status === 'escalated') {
    await db.insertMessage({ sessionId: conv.sessionId, role: 'user', content: userText, meta: { intent: 'escalated_passthrough' } });
    await db.updateConversation(conv.id, { lastMessage: userText, intent: 'escalate' });
    return { ok: true, reply: '人工客服正在接入中，您的消息已同步给坐席，请稍候。', intent: 'escalate', confidence: 1, route: 'escalate' };
  }

  await db.insertMessage({ sessionId: conv.sessionId, role: 'user', content: userText, meta: null });

  const analysis = await analyzeIntent(userText, history, faqs, conv, voiceModel);
  const intent = analysis.intent;

  if (analysis.sentiment === 'angry' && intent !== 'escalate') {
    await escalate(conv, `检测到用户负面情绪（消息：${userText.slice(0, 50)}）`, userText);
    await db.insertMessage({ sessionId: conv.sessionId, role: 'assistant', content: ESCALATE_REPLY, meta: { intent, confidence: analysis.confidence, route: 'escalate' } });
    await db.updateConversation(conv.id, { lastMessage: ESCALATE_REPLY, intent });
    return { ok: true, reply: ESCALATE_REPLY, intent, confidence: analysis.confidence, route: 'escalate', actions: ['request_call'] };
  }

  let material = '';
  let route = intent;
  let resolved = false;
  let flowPatch = null;
  let lastOrderId = null;
  const actions = [];
  let escalatedNow = false;

  if (intent === 'escalate' || analysis.wantsHuman) {
    await escalate(conv, '用户要求人工客服', userText);
    escalatedNow = true;
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
    } else {
      material = '';
    }
  }

  let missCount = conv.missCount || 0;
  if (!resolved && !material && route !== 'escalate') {
    missCount += 1;
  } else {
    missCount = 0;
  }
  if (missCount >= MISS_LIMIT && route !== 'escalate') {
    await escalate(conv, `智能客服连续 ${missCount} 次未能解决问题（意图：${intent}）`, userText);
    escalatedNow = true;
    route = 'escalate';
  }

  let reply;
  if (escalatedNow) {
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
    reply = (await generateReply(userText, history, material, ROUTE_LABEL[route] || route, voiceModel)) || fallback;
  }

  await db.insertMessage({
    sessionId: conv.sessionId,
    role: 'assistant',
    content: reply,
    meta: { intent, confidence: analysis.confidence, route, ai: analysis.source },
  });
  const patch = {
    lastMessage: clampText(reply, 100),
    intent,
    missCount,
    lastOrderId: lastOrderId || conv.lastOrderId || null,
  };
  if (flowPatch) patch.flow = flowPatch;
  if (resolved && route !== 'escalate') patch.status = 'resolved';
  await db.updateConversation(conv.id, patch);

  return { ok: true, reply, intent, confidence: analysis.confidence, route, actions, aiSource: analysis.source };
}

/* ---------------- 其他 action ---------------- */

async function handleStart(event) {
  const conv = await db.ensureConversation(event.sessionId, event.nickname);
  let list = await db.listMessages(conv.sessionId, 200);
  if (!list.length) {
    const welcome =
      '您好，欢迎来到云舟优选智能客服，我是 AI 助手小智 🤖\n我可以帮您：\n1️⃣ 查询订单与物流\n2️⃣ 办理退款/退货\n3️⃣ 解答产品与技术问题\n请问有什么可以帮您？您也可以点击下方快捷按钮直接开始。';
    const saved = await db.insertMessage({ sessionId: conv.sessionId, role: 'assistant', content: welcome, meta: { intent: 'welcome', route: 'welcome' } });
    await db.updateConversation(conv.id, { lastMessage: welcome });
    list = [saved];
  }
  return { ok: true, sessionId: conv.sessionId, status: conv.status, messages: list };
}

async function handleHistory(event) {
  const list = await db.listMessages(event.sessionId, 200);
  const conv = await db.getConversationBySession(event.sessionId);
  return {
    ok: true,
    status: conv ? conv.status : 'open',
    rating: conv ? conv.rating : null,
    messages: list,
  };
}

async function handleRate(event) {
  const rating = Math.round(Number(event.rating));
  if (!(rating >= 1 && rating <= 5)) return { ok: false, error: '评分需为 1-5' };
  const conv = await db.getConversationBySession(event.sessionId);
  if (!conv) return { ok: false, error: '会话不存在' };
  await db.insertSatisfaction({ sessionId: event.sessionId, rating, comment: event.comment, intent: conv.intent });
  await db.updateConversation(conv.id, { rating, status: conv.status === 'escalated' ? 'escalated' : 'closed' });
  await db.insertMessage({ sessionId: event.sessionId, role: 'system', content: `用户完成满意度评价：${'⭐'.repeat(rating)}（${rating}/5 分）`, meta: { type: 'rating' } });
  return { ok: true };
}

async function handleRequestCall(event) {
  const phone = String(event.phone || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) return { ok: false, error: '请输入正确的 11 位手机号' };
  const conv = await db.getConversationBySession(event.sessionId);
  if (!conv) return { ok: false, error: '会话不存在' };
  if (await db.hasPendingCall(event.sessionId)) {
    return { ok: true, message: '您已有一通随访电话排队中，我们会尽快与您联系。' };
  }
  await db.insertCall({
    callId: 'call_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    sessionId: event.sessionId,
    nickname: conv.nickname,
    phone,
    purpose: clampText(event.purpose || '服务回访：了解问题处理进度与满意度', 100),
    source: 'user_request',
  });
  await db.updateConversation(conv.id, { callRequested: true });
  await db.insertMessage({ sessionId: event.sessionId, role: 'system', content: `📞 已登记电话随访请求（${phone}），系统将自动外呼，请保持手机畅通。`, meta: { type: 'call' } });
  return { ok: true, message: '电话随访已登记，系统将自动外呼，请保持手机畅通。' };
}

async function handlePoll(event) {
  const since = Number(event.since || 0);
  const sinceIso = since > 0 ? new Date(since).toISOString() : new Date(0).toISOString();
  const list = await db.listMessagesSince(event.sessionId, sinceIso, 50);
  const conv = await db.getConversationBySession(event.sessionId);
  return {
    ok: true,
    status: conv ? conv.status : 'open',
    rating: conv ? conv.rating : null,
    messages: list,
  };
}

async function main(event) {
  try {
    switch (event.action) {
      case 'start': return await handleStart(event);
      case 'chat': return await handleChat(event);
      case 'history': return await handleHistory(event);
      case 'rate': return await handleRate(event);
      case 'request_call': return await handleRequestCall(event);
      case 'poll': return await handlePoll(event);
      default: return { ok: false, error: `未知 action: ${event.action}` };
    }
  } catch (e) {
    console.error('chat handler error:', e);
    return { ok: false, error: (e && e.message) || '服务内部错误' };
  }
}

module.exports = { main };
