/**
 * cs-call —— 电话随访自动外呼函数（Event Function + 定时触发器，CloudBase PG 版）
 *
 * 定时器每 5 分钟触发 action=process，自动处理 pending 的随访任务：
 *   1. 汇总该用户会话上下文
 *   2. LLM 生成随访外呼话术（失败降级模板）
 *   3. 执行外呼（当前为模拟线路，接入真实语音服务商时替换 dial 相关逻辑即可）
 *   4. 回写结果、话术、摘要，并在用户会话中追加系统通知
 */
const crypto = require('crypto');
const tcb = require('@cloudbase/node-sdk');

const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV });
const db = app.rdb();

const AI_MODEL_ID = process.env.AI_MODEL_ID || 'hy3-preview';
const AI_GROUP = process.env.AI_GROUP || 'hunyuan-v3';
const BATCH_LIMIT = 5;

async function exe(p) {
  const r = await p;
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

let aiModel = null;
function getAi() {
  if (process.env.AI_DISABLED) return null;
  try {
    if (!aiModel) aiModel = app.ai().createModel(AI_GROUP);
    return aiModel;
  } catch (e) {
    console.warn('AI init failed, use template script:', (e && e.message) || e);
    return null;
  }
}

async function llmText(messages, temperature = 0.5) {
  const ai = getAi();
  if (!ai) return null;
  try {
    const r = await ai.generateText({ model: AI_MODEL_ID, messages, temperature });
    return r && typeof r.text === 'string' && r.text.trim() ? r.text.trim() : null;
  } catch (e) {
    console.warn('AI generateText failed:', (e && e.message) || e);
    return null;
  }
}

/** 由 callId 确定性生成外呼结果（同一任务重试结果一致，便于演示） */
function simulateDialOutcome(call) {
  const h = crypto.createHash('md5').update(String(call.call_id || call.id)).digest();
  const score = h[0] % 10;
  if (score < 7) return 'answered'; // 70% 接通
  if (score < 9) return 'no_answer'; // 20% 未接
  return 'failed'; // 10% 线路失败
}

async function buildScript(call, contextDigest) {
  const out = await llmText([
    {
      role: 'system',
      content:
        '你是客服中心的电话随访话术撰写员。根据客户背景写一段 80 字以内的中文外呼开场与随访话术，语气亲切专业，包含：自我介绍（云舟优选客服）、随访目的、1-2 个关键询问点。只输出话术本身。',
    },
    {
      role: 'user',
      content: `【客户】${call.nickname || '客户'}（${call.phone}）\n【随访目的】${call.purpose}\n【会话背景摘要】\n${contextDigest || '（无）'}`,
    },
  ]);
  if (out) return out;
  return `您好，这里是云舟优选客服中心。打扰您一下，关于您近期咨询的问题（${call.purpose}），想跟您做个简短回访：问题是否已经得到解决？您对我们的服务还满意吗？您的意见对我们非常重要。`;
}

async function buildOutcomeNote(call, outcome) {
  if (outcome === 'answered') {
    const out = await llmText(
      [
        {
          role: 'system',
          content: '用一句话（40字内）模拟客户在随访电话中的答复反馈，中文，客观中性。只输出这句话。',
        },
        { role: 'user', content: `随访目的：${call.purpose}` },
      ],
      0.7
    );
    return out || '客户表示问题已基本解决，对处理速度表示认可。';
  }
  if (outcome === 'no_answer') return '客户未接听，将在下个周期再次尝试。';
  return '线路繁忙，外呼失败，已通知人工跟进。';
}

async function processOne(call) {
  if (!['pending', 'dialing'].includes(call.status)) return { ok: true, skipped: true };

  // 标记处理中，防止并发重复外呼
  await exe(db.from('calls').update({ status: 'dialing' }).eq('id', call.id));

  // 汇总会话上下文
  let contextDigest = '';
  if (call.session_id) {
    const msgs = await exe(
      db
        .from('messages')
        .select('*')
        .eq('session_id', call.session_id)
        .order('created_at', { ascending: false })
        .limit(6)
    );
    contextDigest = (msgs.data || [])
      .reverse()
      .map((m) => `${m.role === 'user' ? '用户' : m.role === 'agent' ? '人工' : '客服'}: ${String(m.content).slice(0, 60)}`)
      .join('\n');
  }

  // 1. 生成话术（LLM，失败降级模板）
  const script = await buildScript(call, contextDigest);

  // 2. 执行外呼（模拟线路）
  const outcome = simulateDialOutcome(call);
  const note = await buildOutcomeNote(call, outcome);

  // 3. 回写结果
  const transcript = outcome === 'answered' ? `【话术】${script}\n【客户答复】${note}` : `【话术】${script}\n【结果】${note}`;
  await exe(
    db
      .from('calls')
      .update({
        status: outcome,
        script,
        transcript,
        result: note,
        processed_at: new Date().toISOString(),
      })
      .eq('id', call.id)
  );

  // 4. 会话内追加系统通知（用户可见）
  if (call.session_id) {
    await exe(
      db.from('messages').insert({
        session_id: call.session_id,
        role: 'system',
        content:
          outcome === 'answered'
            ? `📞 电话随访已完成（${call.phone}）：${note}`
            : `📞 电话随访已拨打（${call.phone}）但${outcome === 'no_answer' ? '未接通，我们将稍后再次尝试' : '线路失败，人工将另行跟进'}。`,
        meta: { type: 'call', outcome },
      })
    );
  }
  return { ok: true, callId: call.call_id, status: outcome };
}

/** 兼容 SDK 直调与 HTTP 网关触发（网关把 body 包在 event.body） */
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
    // 定时触发器进入时 event 是触发配置（无 action 字段），默认执行队列处理
    const action = event && event.action ? event.action : 'process';

    if (action === 'process_one') {
      const res = await exe(db.from('calls').select('*').eq('call_id', event.callId).limit(1));
      const call = (res.data || [])[0];
      if (!call) return { ok: false, error: '任务不存在' };
      return await processOne(call);
    }

    // 队列处理（定时器 / 手动批处理）
    const res = await exe(
      db.from('calls').select('*').eq('status', 'pending').order('created_at', { ascending: true }).limit(BATCH_LIMIT)
    );
    const pending = res.data || [];
    const results = [];
    for (const call of pending) {
      results.push(await processOne(call));
    }
    return { ok: true, processed: results.length, results };
  } catch (e) {
    console.error('cs-call error:', e);
    return { ok: false, error: (e && e.message) || '服务内部错误' };
  }
};
