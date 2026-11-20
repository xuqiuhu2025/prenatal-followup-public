'use strict';
// Only speak/voice/prosody are supported by this Edge endpoint.
if (typeof globalThis.crypto === 'undefined') globalThis.crypto = require('crypto').webcrypto;
const http = require('http');
const VOICES = new Set(['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural']);
function badRequest(message) { return Object.assign(Error(message), { status: 400 }); }
function normalize(input, env = process.env) {
  if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1000) throw badRequest('请提供1–1000字播报内容');
  const voice = input.voice ?? env.TTS_VOICE ?? 'zh-CN-XiaoxiaoNeural';
  const rate = input.rate ?? env.TTS_RATE ?? '-5%';
  if (!VOICES.has(voice)) throw badRequest('不支持的音色');
  if (typeof rate !== 'string' || !/^[+-]\d{1,2}%$/.test(rate) || parseInt(rate, 10) < -20 || parseInt(rate, 10) > 10) throw badRequest('语速须在-20%到+10%之间');
  // Keep clinical numbers and units intact. Paragraphs become sentence boundaries.
  const text = input.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
    .replace(/\r\n?/g, '\n').replace(/([。！？；：，.!?;:,])[^\S\n]*\n+/g, '$1').replace(/\n+/g, '。').replace(/[\t ]+/g, ' ');
  if (!text) throw badRequest('播报内容为空');
  const escaped = text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
  return { voice, rate, text: escaped };
}
function createSynthesizer(options = {}) {
  const library = options.library || require('msedge-tts');
  const clients = new Map();
  const getClient = voice => {
    if (clients.has(voice)) return clients.get(voice).ready;
    const entry = { client: new library.MsEdgeTTS({ connectionTimeoutMs: 8000, synthesisTimeoutMs: 18000 }) };
    clients.set(voice, entry);
    entry.ready = Promise.resolve().then(() => entry.client.setMetadata(voice, library.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3))
      .then(() => entry.client).catch(error => { if (clients.get(voice) === entry) clients.delete(voice); entry.client.close(); throw error; });
    return entry.ready;
  };
  async function synthesize(settings, signal) {
    if (signal?.aborted) throw Error('语音播报已取消');
    const client = await getClient(settings.voice);
    if (signal?.aborted) throw Error('语音播报已取消');
    const { audioStream, metadataStream } = client.toStream(settings.text, { rate: settings.rate });
    metadataStream?.on('error', () => {});
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0, settled = false;
      const abort = () => audioStream.destroy(Error('语音播报已取消'));
      const timer = setTimeout(() => audioStream.destroy(Error('语音合成超时')), options.timeoutMs ?? 20000);
      const finish = (error, result) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        metadataStream?.destroy(); error ? reject(error) : resolve(result);
      };
      audioStream.on('data', chunk => { size += chunk.length; if (size > 5 * 1024 * 1024) audioStream.destroy(Error('语音内容过大')); else chunks.push(chunk); });
      audioStream.once('error', error => finish(error));
      audioStream.once('end', () => size < 100 ? finish(Error('语音内容为空')) : finish(null, Buffer.concat(chunks)));
      audioStream.once('close', () => { if (!settled) finish(Error('语音合成被中断')); });
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    });
  }
  return { synthesize, warmup: voice => getClient(voice), close() { for (const entry of clients.values()) entry.client.close(); clients.clear(); } };
}
function createServer(options = {}) {
  const synthesizer = options.synthesizer || createSynthesizer();
  const server = http.createServer(async (req, res) => {
    const sendJson = (code, value) => { if (res.destroyed) return; res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && req.url === '/healthz') return sendJson(200, { ok: true, voiceSettings: 1 });
    if (req.method !== 'POST' || req.url !== '/tts') return sendJson(404, { error: 'not found' });
    const controller = new AbortController(); res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 16384) { sendJson(413, { error: '播报请求过大' }); return; } chunks.push(chunk); }
      let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw badRequest('JSON格式无效'); }
      const settings = normalize(input, options.env);
      const audio = await synthesizer.synthesize(settings, controller.signal);
      if (res.destroyed || controller.signal.aborted) return;
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store', 'X-TTS-Voice': settings.voice, 'X-TTS-Rate': settings.rate });
      res.end(audio);
    } catch (error) { sendJson(error.status || 502, { error: error.status ? error.message : '语音合成暂不可用，请稍后重试' }); }
  });
  server.on('close', () => synthesizer.close?.());
  return { server, synthesizer };
}
module.exports = { normalize, createSynthesizer, createServer };
