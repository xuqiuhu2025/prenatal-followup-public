'use strict';
// Host-side service; keep tts-engine.js beside this entry point when deploying.
const { createServer } = require('./tts-engine');
if (require.main === module) {
  const { server, synthesizer } = createServer();
  const port = Number(process.env.TTS_PORT) || 28852;
  server.listen(port, process.env.TTS_BIND || '0.0.0.0', () => console.log('tts proxy on :' + port));
  synthesizer.warmup(process.env.TTS_VOICE || 'zh-CN-XiaoxiaoNeural').catch(() => console.warn('tts warmup deferred'));
}
module.exports = require('./tts-engine');
