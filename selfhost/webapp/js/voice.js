/**
 * 实时语音通话：MediaRecorder 录 webm/opus → POST /voice（ASR→Agent→TTS）→ 播放 mp3 回复。
 * 两种模式：按住说话；连续对话（自动听下一句，说"挂断/结束"退出）。
 */
(function () {
  var CFG = window.CS_CONFIG;
  var GATE = CFG.gateway || '';
  var sessionId = window.HospitalSession;

  var overlay = document.getElementById('voiceOverlay');
  var orbBtn = document.getElementById('voiceOrb');
  var orbHint = document.getElementById('voiceHint');
  var orbStatus = document.getElementById('voiceStatus');
  var liveText = document.getElementById('voiceLiveText');
  var btnHold = document.getElementById('voiceHold');
  var btnHandsfree = document.getElementById('voiceHandsfree');
  var btnHangup = document.getElementById('voiceHangup');

  var recording = false;
  var busy = false;
  var handsfree = false;
  var active = false;
  var starting = false;
  var holdPressed = false;
  var epoch = 0;
  var recordTimer = null;
  var nextTimer = null;
  var requestController = null;
  var finishPlayback = null;
  var mediaStream = null;
  var recorder = null;
  var audioEl = null;
  var audioContext = null;
  var microphoneAnalyser = null;
  var microphoneSamples = null;
  var analysisFrame = null;
  var interruptedReply = null;
  var playbackCapture = null;
  var hangupWords = ['挂断', '结束', '拜拜', '再见', '退出通话'];
  var interruptThreshold = 0.042;

  function post(action, data) {
    return fetch(GATE + '/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action, sessionId: sessionId }, data || {})),
      signal: requestController.signal,
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function setStatus(t) { if (orbStatus) orbStatus.textContent = t || ''; }
  function setLive(t) { if (liveText) liveText.textContent = t || ''; }
  function setHint(t) { if (orbHint) orbHint.textContent = t || ''; }

  function ensureAudio() {
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
    }
  }

  function playMp3(b64) {
    ensureAudio();
    return new Promise(function (resolve) {
      var settled = false;
      function resolvePlayback(interrupted) {
        finishPlayback = null;
        audioEl.onended = null;
        audioEl.onerror = null;
        resolve(!!interrupted);
      }
      function finish(interrupted) {
        if (settled) return;
        settled = true;
        if (analysisFrame !== null) {
          cancelAnimationFrame(analysisFrame);
          analysisFrame = null;
        }
        if (interrupted) {
          audioEl.pause();
          try { audioEl.currentTime = 0; } catch (e) {}
        } else if (playbackCapture) {
          stopRecorder(playbackCapture).then(function () { resolvePlayback(false); });
          return;
        }
        resolvePlayback(interrupted);
      }
      finishPlayback = function () { finish(false); };
      audioEl.src = 'data:audio/mpeg;base64,' + b64;
      audioEl.onended = function () { finish(false); };
      audioEl.onerror = function () { finish(false); };
      audioEl.play().catch(function () { finish(false); });
      if (handsfree && microphoneAnalyser) {
        playbackCapture = startRecorder(function (blob, capture) {
          if (capture.interrupted && isCurrent(capture.epoch)) processRound(blob);
        }, { passive: true });
        var playbackStartedAt = performance.now();
        var voiceStartedAt = 0;
        function watchPlayback() {
          if (settled || !active || !handsfree) return;
          var now = performance.now();
          if (now - playbackStartedAt >= 180 && microphoneLevel() >= interruptThreshold) {
            if (!voiceStartedAt) voiceStartedAt = now;
            if (now - voiceStartedAt >= 240) {
              if (playbackCapture) {
                playbackCapture.interrupted = true;
                playbackCapture.includeFrom = voiceStartedAt;
                playbackCapture.speechStartedAt = voiceStartedAt;
              }
              finish(true);
              return;
            }
          } else {
            voiceStartedAt = 0;
          }
          analysisFrame = requestAnimationFrame(watchPlayback);
        }
        analysisFrame = requestAnimationFrame(watchPlayback);
      }
    });
  }

  function openOverlay() {
    if (active) return;
    active = true;
    epoch++;
    overlay.classList.add('show');
    setHint('点击开始，或长按说话');
    setStatus('');
    setLive('');
  }
  function closeOverlay() {
    active = false;
    epoch++;
    handsfree = false;
    holdPressed = false;
    starting = false;
    interruptedReply = null;
    busy = false;
    clearTimeout(recordTimer);
    clearTimeout(nextTimer);
    if (requestController) { requestController.abort(); requestController = null; }
    if (audioEl) {
      audioEl.pause();
      audioEl.removeAttribute('src');
      audioEl.load();
    }
    if (finishPlayback) finishPlayback();
    releaseVoiceAnalysis();
    stopTracks();
    overlay.classList.remove('show');
    if (window.parentChatRefresh) window.parentChatRefresh();
  }
  function stopTracks() {
    if (recorder && recorder.state === 'recording') { try { recorder.stop(); } catch (e) {} }
    if (mediaStream) { mediaStream.getTracks().forEach(function (t) { t.stop(); }); mediaStream = null; }
    recorder = null;
    recording = false;
  }

  function isCurrent(roundEpoch) { return active && epoch === roundEpoch; }

  function microphoneLevel() {
    if (!microphoneAnalyser || !microphoneSamples) return 0;
    microphoneAnalyser.getByteTimeDomainData(microphoneSamples);
    var sum = 0;
    for (var i = 0; i < microphoneSamples.length; i++) {
      var sample = (microphoneSamples[i] - 128) / 128;
      sum += sample * sample;
    }
    return Math.sqrt(sum / microphoneSamples.length);
  }

  function releaseVoiceAnalysis() {
    if (analysisFrame !== null) {
      cancelAnimationFrame(analysisFrame);
      analysisFrame = null;
    }
    microphoneAnalyser = null;
    microphoneSamples = null;
    if (audioContext) {
      var oldContext = audioContext;
      audioContext = null;
      try { oldContext.close(); } catch (e) {}
    }
  }

  function prepareVoiceAnalysis(stream) {
    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;
    try {
      if (!audioContext) audioContext = new AudioContextClass();
      var source = audioContext.createMediaStreamSource(stream);
      microphoneAnalyser = audioContext.createAnalyser();
      microphoneAnalyser.fftSize = 1024;
      microphoneAnalyser.smoothingTimeConstant = 0;
      microphoneSamples = new Uint8Array(microphoneAnalyser.fftSize);
      source.connect(microphoneAnalyser);
      if (audioContext.state === 'suspended') audioContext.resume().catch(function () {});
      return true;
    } catch (e) {
      releaseVoiceAnalysis();
      return false;
    }
  }

  async function startSession(roundEpoch) {
    if (mediaStream) return mediaStream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('请使用 HTTPS 地址并允许麦克风');
    }
    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass && !audioContext) {
      try { audioContext = new AudioContextClass(); } catch (e) {}
    }
    var stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (!isCurrent(roundEpoch)) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      return null;
    }
    mediaStream = stream;
    prepareVoiceAnalysis(stream);
    return stream;
  }

  function startRecorder(onStop, options) {
    options = options || {};
    var chunks = [];
    var roundEpoch = epoch;
    var capture = { chunks: chunks, passive: !!options.passive, interrupted: false, includeFrom: -Infinity, epoch: roundEpoch };
    capture.stopped = new Promise(function (resolve) { capture.resolveStopped = resolve; });
    var currentRecorder = new MediaRecorder(mediaStream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' });
    capture.recorder = currentRecorder;
    recorder = currentRecorder;
    currentRecorder.ondataavailable = function (e) {
      if (e.data.size) chunks.push(capture.passive ? { blob: e.data, at: performance.now() } : e.data);
    };
    currentRecorder.onstop = function () {
      capture.resolveStopped();
      if (recorder !== currentRecorder || !isCurrent(roundEpoch)) return;
      clearTimeout(recordTimer);
      recording = false;
      recorder = null;
      if (playbackCapture === capture) playbackCapture = null;
      var selected = capture.passive && capture.interrupted
        ? chunks.filter(function (chunk) { return chunk.at >= capture.includeFrom; }).map(function (chunk) { return chunk.blob; })
        : chunks.map(function (chunk) { return capture.passive ? chunk.blob : chunk; });
      if (onStop) onStop(new Blob(selected, { type: 'audio/webm' }), capture);
    };
      currentRecorder.start(options.passive ? 100 : undefined);
    recording = !options.passive;
    return capture;
  }

  function stopRecorder(capture) {
    if (capture && capture.recorder.state === 'recording') {
      try { capture.recorder.stop(); } catch (e) {}
    }
    return capture ? capture.stopped : Promise.resolve();
  }

  function blobToB64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(',')[1] || ''); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  function isHangup(text) {
    return hangupWords.some(function (w) { return (text || '').indexOf(w) >= 0; });
  }

  async function processRound(blob) {
    if (!active || busy) return;
    var roundEpoch = epoch;
    var nextDelay = 0;
    var interrupted = false;
    busy = true;
    requestController = new AbortController();
    setStatus('识别中…');
    setLive('');
    try {
      var b64 = await blobToB64(blob);
      if (!isCurrent(roundEpoch)) return;
      if (!b64 || b64.length < 400) {
        setStatus('没听到声音，再说一次');
        nextDelay = 1200;
        return;
      }
      var turn = { audio: b64 };
      if (interruptedReply) turn.interruptedReply = interruptedReply;
      var r = await post('chat', turn);
      if (!isCurrent(roundEpoch)) return;
      if (!r || !r.ok) {
        setStatus((r && r.error) || '处理失败');
        nextDelay = 1500;
        return;
      }
      if (turn.interruptedReply === interruptedReply) interruptedReply = null;
      setLive('你：' + r.transcript + '\n助手：' + (r.reply || ''));
      setStatus('助手回答中…');
      if (r.audio) {
        interrupted = await playMp3(r.audio);
        if (interrupted) interruptedReply = r.reply || '';
      }
      if (!isCurrent(roundEpoch)) return;
      if (interrupted) {
        setLive('你：' + r.transcript + '\n助手（上一句未播完）：' + (r.reply || ''));
      }
      if (isHangup(r.transcript)) {
        closeOverlay();
        return;
      }
      setStatus('按住说话，或点击圆球继续');
    } catch (e) {
      if (isCurrent(roundEpoch)) setStatus('出错：' + ((e && e.message) || '未知'));
      nextDelay = 1500;
    } finally {
      if (isCurrent(roundEpoch)) {
        busy = false;
        requestController = null;
        if (handsfree) {
          if (interrupted) waitForInterruptionEnd();
          else nextTimer = setTimeout(listenLoop, nextDelay);
        }
      }
    }
  }

  function waitForInterruptionEnd() {
    if (!active || !handsfree || busy || recording) return;
    var capture = playbackCapture;
    if (!capture || !microphoneAnalyser) {
      setStatus('此设备无法自动检测插话，请按住说话');
      return;
    }
    setStatus('听到你插话了，继续说…');
    var currentRecorder = capture.recorder;
    var roundEpoch = epoch;
    var startedAt = capture.speechStartedAt;
    var lastVoiceAt = performance.now();
    function watchUtterance() {
      if (!isCurrent(roundEpoch) || recorder !== currentRecorder || currentRecorder.state !== 'recording') return;
      var now = performance.now();
      if (microphoneLevel() >= interruptThreshold) lastVoiceAt = now;
      if (now - startedAt >= 12000 || (now - startedAt >= 450 && now - lastVoiceAt >= 850)) {
        stopRecorder(capture);
        return;
      }
      analysisFrame = requestAnimationFrame(watchUtterance);
    }
    recordTimer = setTimeout(function () { stopRecorder(capture); }, 12000);
    analysisFrame = requestAnimationFrame(watchUtterance);
  }

  function listenLoop() {
    if (!active || !handsfree || busy || recording) return;
    setStatus('免提录音中…每段 3.2 秒');
    startRecorder(processRound);
    var currentRecorder = recorder;
    // 连续模式固定录 3.2 秒一段
    recordTimer = setTimeout(function () {
      if (recorder === currentRecorder && currentRecorder.state === 'recording') currentRecorder.stop();
    }, 3200);
  }

  /* ---------- 交互绑定 ---------- */
  async function beginRecording(mode) {
    if (!active || busy || recording || starting) return;
    var roundEpoch = epoch;
    starting = true;
    clearTimeout(nextTimer);
    try {
      await startSession(roundEpoch);
      if (!isCurrent(roundEpoch) || (mode === 'hold' && !holdPressed)) return;
      handsfree = mode === 'handsfree';
      if (handsfree) setHint(microphoneAnalyser ? '助手播放时可直接插话' : '此设备不支持自动插话检测');
      if (handsfree) { listenLoop(); return; }
      setStatus(mode === 'hold' ? '录音中…松开发送' : '录音中…说完点一下圆球');
      startRecorder(processRound);
    } catch (e) {
      if (isCurrent(roundEpoch)) setStatus('无法录音：' + ((e && e.message) || '请检查麦克风权限'));
    } finally {
      if (isCurrent(roundEpoch)) starting = false;
    }
  }

  orbBtn.addEventListener('click', function () {
    if (recording) { if (recorder.state === 'recording') recorder.stop(); return; }
    beginRecording('manual');
  });

  btnHold.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    holdPressed = true;
    try { btnHold.setPointerCapture(e.pointerId); } catch (err) {}
    beginRecording('hold');
  });
  function releaseHold() {
    if (!holdPressed) return;
    holdPressed = false;
    if (!handsfree && recorder && recorder.state === 'recording') recorder.stop();
  }
  btnHold.addEventListener('pointerup', releaseHold);
  btnHold.addEventListener('pointercancel', releaseHold);
  btnHold.addEventListener('lostpointercapture', releaseHold);

  btnHandsfree.addEventListener('click', function () { beginRecording('handsfree'); });

  btnHangup.addEventListener('click', function () {
    setStatus('通话已结束');
    closeOverlay();
  });

  /* ---------- 对外：聊天页按钮打开 ---------- */
  window.__openVoiceCall = function () { openOverlay(); };
})();
