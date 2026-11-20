/**
 * 电话随访（自托管版）：任务队列 + LLM 生成话术 + 模拟外呼（接真实线路时替换 simulateDialOutcome）
 */
const crypto = require('crypto');
const db = require('./db');
const llm = require('./llm');

const BATCH_LIMIT = 5;

/** 由 callId 确定性生成外呼结果（演示用模拟线路） */
function simulateDialOutcome(call) {
  const h = crypto.createHash('md5').update(String(call.call_id || call.id)).digest();
  const score = h[0] % 10;
  if (score < 7) return 'answered'; // 70% 接通
  if (score < 9) return 'no_answer'; // 20% 未接
  return 'failed'; // 10% 线路失败
}

async function buildScript(call, contextDigest) {
  const out = await llm.chat(
    [
      {
        role: 'system',
        content:
          '你是客服中心的电话随访话术撰写员。根据客户背景写一段 80 字以内的中文外呼开场与随访话术，语气亲切专业，包含：自我介绍（云舟优选客服）、随访目的、1-2 个关键询问点。只输出话术本身。',
      },
      {
        role: 'user',
        content: `【客户】${call.nickname || '客户'}（${call.phone}）\n【随访目的】${call.purpose}\n【会话背景摘要】\n${contextDigest || '（无）'}`,
      },
    ],
    { temperature: 0.5, maxTokens: 1024 }
  );
  if (out) return out;
  return `您好，这里是云舟优选客服中心。打扰您一下，关于您近期咨询的问题（${call.purpose}），想跟您做个简短回访：问题是否已经得到解决？您对我们的服务还满意吗？您的意见对我们非常重要。`;
}

async function buildOutcomeNote(call, outcome) {
  if (outcome === 'answered') {
    const out = await llm.chat(
      [
        { role: 'system', content: '用一句话（40字内）模拟客户在随访电话中的答复反馈，中文，客观中性。只输出这句话。' },
        { role: 'user', content: `随访目的：${call.purpose}` },
      ],
      { temperature: 0.7, maxTokens: 512 }
    );
    return out || '客户表示问题已基本解决，对处理速度表示认可。';
  }
  if (outcome === 'no_answer') return '客户未接听，将在下个周期再次尝试。';
  return '线路繁忙，外呼失败，已通知人工跟进。';
}

async function processOne(call) {
  if (!['pending', 'dialing'].includes(call.status)) return { ok: true, skipped: true };

  await db.updateCall(call.id, { status: 'dialing' });

  let contextDigest = '';
  if (call.session_id) {
    const msgs = await db.recentMessages(call.session_id, 6);
    contextDigest = msgs
      .map((m) => `${m.role === 'user' ? '用户' : m.role === 'agent' ? '人工' : '客服'}: ${String(m.content).slice(0, 60)}`)
      .join('\n');
  }

  const script = await buildScript(call, contextDigest);
  const outcome = simulateDialOutcome(call);
  const note = await buildOutcomeNote(call, outcome);
  const transcript = outcome === 'answered' ? `【话术】${script}\n【客户答复】${note}` : `【话术】${script}\n【结果】${note}`;

  await db.updateCall(call.id, { status: outcome, script, transcript, result: note, processedAt: Date.now() });

  if (call.session_id) {
    await db.insertMessage({
      sessionId: call.session_id,
      role: 'system',
      content:
        outcome === 'answered'
          ? `📞 电话随访已完成（${call.phone}）：${note}`
          : `📞 电话随访已拨打（${call.phone}）但${outcome === 'no_answer' ? '未接通，我们将稍后再次尝试' : '线路失败，人工将另行跟进'}。`,
      meta: { type: 'call', outcome },
    });
  }
  return { ok: true, callId: call.call_id, status: outcome };
}

async function processQueue() {
  const pending = await db.listPendingCalls(BATCH_LIMIT);
  const results = [];
  for (const call of pending) {
    results.push(await processOne(call));
  }
  return { processed: results.length, results };
}

async function main(event) {
  try {
    const action = event && event.action ? event.action : 'process';
    if (action === 'process_one') {
      const call = await db.getCallByCallId(event.callId);
      if (!call) return { ok: false, error: '任务不存在' };
      return await processOne(call);
    }
    return await processQueue();
  } catch (e) {
    console.error('call handler error:', e);
    return { ok: false, error: (e && e.message) || '服务内部错误' };
  }
}

module.exports = { main, processOne, processQueue };
