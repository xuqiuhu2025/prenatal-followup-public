/**
 * LLM 层：OpenAI 兼容接口调用自建 new-api 网关。
 * 失败/超时返回 null，上层自动降级为模板回复。
 */
const BASE = (process.env.LLM_BASE || '').replace(/\/+$/, '');
const KEY = process.env.LLM_KEY || '';
const MODEL = process.env.LLM_MODEL || 'glm-5.3-flash';
const MODEL_VOICE = process.env.LLM_MODEL_VOICE || MODEL;

function enabled() {
  return !!(BASE && KEY && !process.env.AI_DISABLED);
}

async function chat(messages, { temperature = 0.5, maxTokens = 2048, timeoutMs = 60000, model, reasoningEffort, thinking, signal, onTiming } = {}) {
  if (!enabled()) return null;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) return null;
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started=Date.now(),timing={model:model||MODEL};
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: model || MODEL, messages, temperature, max_tokens: maxTokens, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}), ...(thinking ? {thinking} : {}) }),
      signal: controller.signal,
    });
    timing.headersMs=Date.now()-started;timing.status=r.status;
    if (!r.ok) {
      console.warn('LLM HTTP', r.status);
      return null;
    }
    const j = await r.json();
    timing.reasoningTokens=j.usage?.completion_tokens_details?.reasoning_tokens||0;timing.outputTokens=j.usage?.completion_tokens;
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    if (msg && typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content.trim();
    }
    console.warn('LLM empty content');
    return null;
  } catch (e) {
    timing.failure=controller.signal.aborted?'aborted':'transport';
    if(!signal?.aborted)console.warn('LLM call failed:', e && e.message);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if(onTiming)onTiming({...timing,totalMs:Date.now()-started});
  }
}

module.exports = { chat, enabled, MODEL, MODEL_VOICE };
