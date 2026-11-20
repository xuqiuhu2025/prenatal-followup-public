'use strict';
const voices = Object.freeze([
  { id: 'xiaoxiao', name: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声', description: '默认随访音色，搭配舒缓语速。' },
  { id: 'xiaoyi', name: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声', description: '另一款普通话女声，可试听比较。' },
  { id: 'yunxi', name: 'zh-CN-YunxiNeural', label: '云希 · 男声', description: '普通话男声，可试听比较。' }
].map(Object.freeze));
const speeds = Object.freeze([
  { id: 'calm', label: '舒缓 · 推荐', rate: '-5%' },
  { id: 'slow', label: '更慢一些', rate: '-12%' },
  { id: 'standard', label: '标准语速', rate: '+0%' }
].map(Object.freeze));
const SAMPLE_TEXT = '您好，我是中心的AI随访助手。现在方便聊几句吗？这阵子您身体恢复得怎么样？没关系，记不清的内容可以先放一放。';
function resolve(selection, env = process.env) {
  if (selection != null && (typeof selection !== 'object' || Array.isArray(selection))) throw Error('音色设置无效');
  const voice = voices.find(item => item.id === (selection?.id ?? env.FOLLOWUP_VOICE ?? 'xiaoxiao'));
  const speed = speeds.find(item => item.id === (selection?.speed ?? env.FOLLOWUP_VOICE_SPEED ?? 'calm'));
  if (!voice || !speed) throw Error('请选择可用的音色和语速');
  return { id: voice.id, speed: speed.id, voice: voice.name, rate: speed.rate, label: voice.label + ' · ' + speed.label };
}
function catalog() {
  const current = resolve();
  return { voices: voices.map(({ id, label, description }) => ({ id, label, description })),
    speeds: speeds.map(({ id, label }) => ({ id, label })),
    default: { id: current.id, speed: current.speed }, sampleText: SAMPLE_TEXT };
}
module.exports = { resolve, catalog, SAMPLE_TEXT };
