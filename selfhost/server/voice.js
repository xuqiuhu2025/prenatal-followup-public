/**
 * 实时语音通话处理：
 * webm/opus 音频 → ffmpeg 转 16k wav → ASR(cs-asr) → Agent(chat handler，语音模式用快速模型)
 * → TTS(msedge-tts 免费音色) → 返回 mp3
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const chat = require('./hospital-chat');
const {randomUUID}=require('crypto');

const ASR_URL = process.env.ASR_URL || 'http://cs-asr:8000';
const TTS_URL = (process.env.TTS_URL || 'http://host.docker.internal:28852').replace(/\/+$/, '');

function tmpFile(name) {
  return path.join(os.tmpdir(), name);
}

/** ffmpeg 转 16k mono wav */
function toWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', outputPath], (err, stdout, stderr) => {
      if (err) return reject(new Error('ffmpeg failed: ' + (stderr || err.message).slice(0, 200)));
      resolve(outputPath);
    });
  });
}

async function asrWav(wavPath) {
  const buffer = fs.readFileSync(wavPath);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'audio.wav');
  const r = await fetch(`${ASR_URL}/asr`, { method: 'POST', body: form });
  if (!r.ok) throw new Error('ASR HTTP ' + r.status);
  const j = await r.json();
  return (j.text || '').trim();
}

async function tts(text) {
  const r = await fetch(TTS_URL + '/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error('TTS HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function main(event) {
  const inPath = tmpFile('voice_in_' + randomUUID() + '.webm');
  const wavPath = tmpFile('voice_out_' + randomUUID() + '.wav');
  try {
    if(!/^h_[a-f0-9-]{36}$/i.test(String(event.sessionId||'')))return {ok:false,error:'会话无效，请刷新页面'};
    const b64 = String(event.audio || '');
    if (!b64) return { ok: false, error: '音频为空' };
    fs.writeFileSync(inPath, Buffer.from(b64, 'base64'));

    await toWav(inPath, wavPath);
    const transcript = await asrWav(wavPath);
    if (!transcript) {
      return { ok: false, stage: 'asr', error: '没有听清，请再试一次' };
    }

    // Share the hospital guidance conversation with text chat.
    const r = await chat.main({
      action: 'chat',
      sessionId: event.sessionId,
      message: transcript,
      _voice: true,
      ...(typeof event.interruptedReply === 'string' ? { interruptedReply: event.interruptedReply } : {}),
    });
    if (!r || !r.ok) {
      return { ok: false, stage: 'agent', error: (r && r.error) || 'Agent 处理失败', transcript };
    }

    let audio = null;
    try {
      const mp3 = await tts(r.reply);
      audio = mp3.toString('base64');
    } catch (e) {
      console.warn('TTS failed (reply still returned):', e && e.message);
    }

    return {
      ok: true,
      transcript,
      reply: r.reply,
      intent: r.intent,
      confidence: r.confidence,
      route: r.route,
      audio,
      audioMime: 'audio/mpeg',
    };
  } catch (e) {
    console.error('voice handler error:', e);
    return { ok: false, error: (e && e.message) || '语音处理失败' };
  } finally {
    try { fs.unlinkSync(inPath); } catch (e) {}
    try { fs.unlinkSync(wavPath); } catch (e) {}
  }
}

module.exports = { main };
