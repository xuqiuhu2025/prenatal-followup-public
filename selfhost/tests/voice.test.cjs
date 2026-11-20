const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.VOICE_SCRIPT || path.join(__dirname, '../webapp/js/voice.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

function setup({ microphone, response } = {}) {
  const nodes = new Map();
  const timers = new Map();
  const recordings = [];
  const requests = [];
  const frames = new Map();
  let timerId = 0;
  let frameId = 0;
  let now = 0;
  let micLevel = 0;
  let stoppedTracks = 0;
  const stream = { getTracks: () => [{ stop() { stoppedTracks++; } }] };
  const audio = {
    style: {}, plays: 0, pauses: 0,
    play() { this.plays++; return Promise.resolve(); },
    pause() { this.pauses++; },
    removeAttribute() {}, load() {},
  };
  const analyser = {
    fftSize: 0, smoothingTimeConstant: 0,
    getByteTimeDomainData(data) {
      const offset = Math.round(micLevel * 128);
      data.fill(128 + offset);
    },
  };
  class AudioContextMock {
    constructor() { this.state = 'running'; this.closed = false; }
    createAnalyser() { return analyser; }
    createMediaStreamSource() { return { connect() {} }; }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
  }
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', handlers: {},
      classList: { add() {}, remove() {} },
      addEventListener(event, handler) { this.handlers[event] = handler; },
      setPointerCapture() {},
    });
    return nodes.get(id);
  }
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; recordings.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable({ data: new Blob(['voice']) });
        this.onstop();
      });
    }
  }
  const window = { HospitalSession: 'test-session', CS_CONFIG: { gateway: '' }, AudioContext: AudioContextMock, parentChatRefresh() {} };
  vm.runInNewContext(source, {
    window, document: { getElementById: node, createElement: () => audio, body: { appendChild() {} } },
    navigator: { mediaDevices: { getUserMedia: () => microphone ? microphone.promise : Promise.resolve(stream) } },
    localStorage: { getItem: () => 'test-session', setItem() {} },
    MediaRecorder: Recorder, Blob, AbortController, Uint8Array, performance: { now: () => now },
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    FileReader: class {
      readAsDataURL() { this.result = 'data:audio/webm;base64,' + 'a'.repeat(800); queueMicrotask(() => this.onload()); }
    },
    fetch(url, options) {
      requests.push({ url, options });
      return response ? response.promise : Promise.resolve({ ok: true, json: async () => ({ ok: true, transcript: 'hello', reply: 'hi', audio: 'mp3' }) });
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  window.__openVoiceCall();
  return {
    window, stream, audio, recordings, requests, node, timers, frames, analyser,
    get stoppedTracks() { return stoppedTracks; },
    setMicLevel(level) { micLevel = level; },
    async frame(ms = 50) {
      now += ms;
      const current = [...frames.values()];
      frames.clear();
      current.forEach(callback => callback(now));
      await flush();
    },
    async fire(id, event = 'click') {
      node(id).handlers[event]({ preventDefault() {}, pointerId: 1 });
      await flush();
    },
    async tick(delay) {
      const found = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(found, `Expected timer for ${delay}ms`);
      timers.delete(found[0]);
      found[1].callback();
      await flush();
    },
    async waitFor(check) {
      for (let i = 0; i < 30; i++) {
        if (check()) return;
        await flush();
      }
      assert.ok(check(), 'Expected asynchronous voice turn to finish');
    },
    async finishAudio() { assert.equal(typeof audio.onended, 'function'); audio.onended(); await flush(); },
  };
}

test('handsfree submits each recording and listens again after playback', async () => {
  const h = setup();
  await h.fire('voiceHandsfree');
  await h.tick(3200);
  assert.equal(h.requests.length, 1);
  assert.equal(JSON.parse(h.requests[0].options.body).sessionId, 'test-session');
  assert.equal(h.audio.plays, 1);
  assert.equal(h.recordings.length, 2, 'handsfree captures a temporary buffer during playback');
  await h.finishAudio();
  await h.tick(0);
  assert.equal(h.recordings.length, 3);
  await h.tick(3200);
  assert.equal(h.requests.length, 2);
});

test('handsfree playback ignores low noise and finishes before opening the next turn', async () => {
  const h = setup();
  await h.fire('voiceHandsfree');
  await h.tick(3200);
  h.setMicLevel(0.02);
  for (let i = 0; i < 12; i++) await h.frame(50);
  assert.equal(h.audio.pauses, 0);
  assert.equal(h.recordings.length, 2);
  await h.finishAudio();
  await h.tick(0);
  assert.equal(h.recordings.length, 3);
  assert.equal(h.requests.length, 1, 'non-interrupted capture is discarded');
});

test('handsfree speech during playback stops audio and records the full interruption', async () => {
  const h = setup();
  await h.fire('voiceHandsfree');
  await h.tick(3200);
  assert.equal(h.recordings.length, 2);
  h.setMicLevel(0.12);
  for (let i = 0; i < 10 && h.audio.pauses === 0; i++) await h.frame(50);
  assert.equal(h.audio.pauses, 1);
  assert.equal(h.recordings.length, 2, 'capture is already running during playback');
  assert.match(h.node('voiceLiveText').textContent, /上一句未播完/);
  h.setMicLevel(0.12);
  for (let i = 0; i < 10; i++) await h.frame(50);
  h.setMicLevel(0);
  for (let i = 0; i < 20; i++) await h.frame(50);
  await h.waitFor(() => h.requests.length === 2);
  assert.equal(h.requests.length, 2);
  assert.equal(JSON.parse(h.requests[1].options.body).action, 'chat');
  assert.equal(JSON.parse(h.requests[1].options.body).interruptedReply, 'hi');
});

test('manual round can record again, and processing blocks overlapping recordings', async () => {
  const h = setup();
  await h.fire('voiceOrb');
  await h.fire('voiceOrb');
  assert.equal(h.requests.length, 1);
  await h.fire('voiceOrb');
  assert.equal(h.recordings.length, 1);
  await h.finishAudio();
  await h.fire('voiceOrb');
  assert.equal(h.recordings.length, 2);
  await h.fire('voiceOrb');
  assert.equal(h.requests.length, 2);
});

test('hanging up discards unfinished recording and cancels timers', async () => {
  const h = setup();
  await h.fire('voiceHandsfree');
  await h.fire('voiceHangup');
  assert.equal(h.requests.length, 0);
  assert.equal(h.stoppedTracks, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.frames.size, 0);
});

test('late response after hangup does not play or restart recording', async () => {
  const response = deferred();
  const h = setup({ response });
  await h.fire('voiceHandsfree');
  await h.tick(3200);
  await h.fire('voiceHangup');
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.window.__openVoiceCall();
  response.resolve({ ok: true, json: async () => ({ ok: true, transcript: 'hello', audio: 'mp3' }) });
  await flush();
  assert.equal(h.audio.plays, 0);
  assert.equal(h.recordings.length, 1);
  assert.equal(h.timers.size, 0);
});

test('hangup stops playback and a reopened call can start', async () => {
  const h = setup();
  await h.fire('voiceHandsfree');
  await h.tick(3200);
  await h.fire('voiceHangup');
  assert.equal(h.audio.pauses, 1);
  assert.equal(h.timers.size, 0);
  h.window.__openVoiceCall();
  await h.fire('voiceOrb');
  assert.equal(h.recordings.length, 3);
});

test('microphone permission completing after hangup releases its stream', async () => {
  const microphone = deferred();
  const h = setup({ microphone });
  await h.fire('voiceOrb');
  await h.fire('voiceHangup');
  microphone.resolve(h.stream);
  await flush();
  assert.equal(h.stoppedTracks, 1);
  assert.equal(h.recordings.length, 0);
});

test('releasing hold while permission is pending does not start a stuck recording', async () => {
  const microphone = deferred();
  const h = setup({ microphone });
  await h.fire('voiceHold', 'pointerdown');
  await h.fire('voiceHold', 'pointerup');
  microphone.resolve(h.stream);
  await flush();
  assert.equal(h.recordings.length, 0);
  await h.fire('voiceHold', 'pointerdown');
  await h.fire('voiceHold', 'pointerup');
  assert.equal(h.requests.length, 1);
});

test('handsfree retries after service failure', async () => {
  const response = deferred();
  const h = setup({ response });
  await h.fire('voiceHandsfree');
  await h.tick(3200);
  response.resolve({ ok: false, status: 502 });
  await flush();
  assert.match(h.node('voiceStatus').textContent, /502/);
  await h.tick(1500);
  assert.equal(h.recordings.length, 2);
});
