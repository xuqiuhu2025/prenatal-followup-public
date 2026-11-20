'use strict';

// Pilot-only: every destination must be explicitly allowed on the server.
function read(env = process.env) {
  const enabled = env.TELEPHONY_ENABLED === '1';
  const number = (key, fallback, min, max) => {
    const value = Number(env[key] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw Error('电话参数范围无效：' + key);
    return value;
  };
  const config = {
    enabled, host: env.AMI_HOST || '127.0.0.1', port: number('AMI_PORT', 5038, 1, 65535),
    username: env.AMI_USERNAME || '', secret: env.AMI_SECRET || '',
    trunk: env.TELEPHONY_TRUNK || '', callerId: env.TELEPHONY_CALLER_ID || '',
    prefix: env.TELEPHONY_DIAL_PREFIX || '',
    mediaHost: env.TELEPHONY_MEDIA_HOST || '127.0.0.1',
    mediaPort: number('TELEPHONY_MEDIA_PORT', 9092, 1, 65535),
    mediaTarget: env.TELEPHONY_MEDIA_TARGET || 'cs-app:9092',
    peers: (env.TELEPHONY_MEDIA_PEERS || '127.0.0.1').split(',').map(x => x.trim()).filter(Boolean),
    allowlist: (env.TELEPHONY_TEST_NUMBERS || '').split(',').map(x => x.trim()).filter(Boolean),
    center: env.TELEPHONY_CENTER_NAME || '产前筛查与诊断中心',
    ringMs: number('TELEPHONY_RING_SECONDS', 30, 10, 60) * 1000,
    maxMs: number('TELEPHONY_MAX_SECONDS', 480, 60, 900) * 1000,
    maxConcurrent: number('TELEPHONY_CONCURRENCY', 1, 1, 5),
    startHour: number('TELEPHONY_START_HOUR', 9, 8, 20),
    endHour: number('TELEPHONY_END_HOUR', 18, 9, 21),
    vadThreshold: number('TELEPHONY_VAD_RMS', 600, 100, 4000),
    silenceMs: number('TELEPHONY_SILENCE_MS', 800, 400, 1600)
  };
  if (!enabled) return config;
  if (!config.username || !config.secret || /[\r\n]/.test(config.username + config.secret)) throw Error('请配置电话网关账号');
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(config.trunk)) throw Error('请配置 SIP 线路名称');
  if (!/^\+?[0-9]{6,20}$/.test(config.callerId) || !/^[0-9]{0,6}$/.test(config.prefix)) throw Error('请配置有效的医院主叫号码');
  if (!/^[a-zA-Z0-9.-]+:[0-9]{1,5}$/.test(config.mediaTarget)) throw Error('电话音频地址无效');
  if (!config.allowlist.length || config.allowlist.some(x => !/^1[3-9][0-9]{9}$/.test(x))) throw Error('请配置已授权的试拨号码清单');
  if (!config.peers.length || config.peers.some(x => !/^[0-9a-f:.]+$/i.test(x))) throw Error('请配置电话网关的音频来源 IP');
  if (config.startHour >= config.endHour || /[\r\n<>]/.test(config.center) || config.center.length > 60) throw Error('电话时段或中心名称无效');
  return config;
}
function inHours(config, date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(date));
  return hour >= config.startHour && hour < config.endHour;
}
module.exports = { read, inHours };
