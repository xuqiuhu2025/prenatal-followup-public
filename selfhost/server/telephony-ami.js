'use strict';
const net = require('net');
const { EventEmitter } = require('events');
const crypto = require('crypto');

class Ami extends EventEmitter {
  constructor(config) {
    super(); this.config = config; this.pending = new Map(); this.ready = false; this.stopped = true;
  }
  start() { this.stopped = false; this.connect(); }
  connect() {
    if (this.stopped) return;
    const socket = net.createConnection({ host: this.config.host, port: this.config.port });
    this.socket = socket; let buffer = '';
    const deadline = setTimeout(() => socket.destroy(), 7000);
    socket.setNoDelay(true); socket.setKeepAlive(true, 15000);
    socket.on('error', () => {});
    socket.on('connect', async () => {
      try {
        await this.action({ Action: 'Login', Username: this.config.username, Secret: this.config.secret, Events: 'on' });
        clearTimeout(deadline); this.ready = true; this.emit('ready');
        this.heartbeat = setInterval(() => this.action({ Action: 'Ping' }).catch(() => socket.destroy()), 15000);
        this.heartbeat.unref();
      } catch { socket.destroy(); }
    });
    socket.on('data', data => {
      buffer += data.toString('utf8');
      if (buffer.length > 262144) return socket.destroy();
      let at;
      while ((at = buffer.indexOf('\r\n\r\n')) >= 0) {
        const lines = buffer.slice(0, at).split('\r\n'); buffer = buffer.slice(at + 4);
        const packet = {};
        for (const line of lines) { const colon = line.indexOf(':'); if (colon > 0) packet[line.slice(0, colon)] = line.slice(colon + 1).trim(); }
        if (packet.Event) this.emit('event', packet);
        else if (packet.ActionID && this.pending.has(packet.ActionID)) {
          const waiting = this.pending.get(packet.ActionID); this.pending.delete(packet.ActionID); clearTimeout(waiting.timer);
          packet.Response === 'Success' ? waiting.resolve(packet) : waiting.reject(Error('电话网关拒绝操作'));
        }
      }
    });
    socket.on('close', () => {
      clearTimeout(deadline); clearInterval(this.heartbeat); this.ready = false;
      for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(Error('电话网关连接中断')); }
      this.pending.clear(); this.emit('offline');
      if (!this.stopped) { this.reconnect = setTimeout(() => this.connect(), 5000); this.reconnect.unref(); }
    });
  }
  action(fields, timeout = 5000) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(Error('电话网关未连接'));
    const id = fields.ActionID || crypto.randomUUID();
    const entries = Object.entries({ ...fields, ActionID: id }).flatMap(([key, value]) =>
      key === 'Variable' && Array.isArray(value) ? value.map(variable => [key, variable]) : [[key, value]]);
    if (entries.some(([key, value]) => /[\r\n]/.test(key + String(value)))) return Promise.reject(Error('无效电话控制参数'));
    if (this.pending.has(id)) return Promise.reject(Error('电话操作正在处理中'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('电话网关响应超时')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(entries.map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n');
    });
  }
  dial(call) {
    return this.action({ Action: 'Originate', ActionID: call.id, Channel: 'PJSIP/' + this.config.prefix + call.phone + '@' + this.config.trunk,
      ChannelId: call.id, CallerID: '"' + this.config.callerId + '" <' + this.config.callerId + '>', Timeout: this.config.ringMs, Async: 'true',
      Context: 'followup-agent', Exten: 's', Priority: 1,
      Variable: ['FOLLOWUP_ID=' + call.id,'FOLLOWUP_MEDIA=' + this.config.mediaTarget,'FOLLOWUP_LIMIT=' + Math.ceil(this.config.maxMs / 1000)] });
  }
  hangup(channel) { return this.action({ Action: 'Hangup', Channel: channel, Cause: 16 }); }
  stop() { this.stopped = true; clearTimeout(this.reconnect); clearInterval(this.heartbeat); this.socket?.destroy(); }
}
module.exports = { Ami };
