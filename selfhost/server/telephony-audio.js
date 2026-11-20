'use strict';
const { EventEmitter } = require('events');

function frame(type, data = Buffer.alloc(0)) {
  if (data.length > 65535) throw Error('AudioSocket frame too large');
  const header = Buffer.alloc(3); header[0] = type; header.writeUInt16BE(data.length, 1);
  return Buffer.concat([header, data]);
}
class Parser {
  constructor(onFrame) { this.buffer = Buffer.alloc(0); this.onFrame = onFrame; }
  push(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 3) {
      const type = this.buffer[0], length = this.buffer.readUInt16BE(1);
      if (length > 8000) throw Error('AudioSocket payload too large');
      if (this.buffer.length < length + 3) return;
      const payload = this.buffer.subarray(3, length + 3); this.buffer = this.buffer.subarray(length + 3);
      this.onFrame(type, payload);
    }
  }
}
function uuid(data) {
  if (data.length !== 16) throw Error('Invalid AudioSocket UUID');
  const hex = data.toString('hex');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
function wav(pcm, rate = 8000) {
  const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(pcm.length + 36, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16,16); h.writeUInt16LE(1,20); h.writeUInt16LE(1,22); h.writeUInt32LE(rate,24);
  h.writeUInt32LE(rate*2,28); h.writeUInt16LE(2,32); h.writeUInt16LE(16,34); h.write('data',36); h.writeUInt32LE(pcm.length,40);
  return Buffer.concat([h,pcm]);
}
// Narrowband PCM is emitted in 20 ms frames. Sustained caller speech interrupts playback.
class Vad extends EventEmitter {
  constructor({ threshold = 600, silenceMs = 800, previewMs = 260 } = {}) {
    super(); this.threshold = threshold; this.silenceMs = silenceMs; this.previewMs=Math.min(previewMs,silenceMs);this.utteranceId=0;this.buffer = Buffer.alloc(0); this.reset();
  }
  reset() { this.pre = []; this.parts = []; this.talking = false; this.voiced = 0; this.silent = 0; this.duration = 0; this.previewed=false; }
  // Keep the recognizer's entire 260 ms endpoint context; over-trimming can
  // weaken short negations and final syllables on a narrowband phone line.
  audio() { const pcm=Buffer.concat(this.parts);return pcm.subarray(0,Math.max(0,pcm.length-Math.max(0,this.silent-this.previewMs)*16)); }
  push(data) {
    if (data.length % 2) throw Error('Invalid PCM frame');
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 320) {
      const chunk = this.buffer.subarray(0,320); this.buffer = this.buffer.subarray(320);
      let sum = 0; for (let i=0;i<320;i+=2) { const v=chunk.readInt16LE(i); sum+=v*v; }
      const voice = Math.sqrt(sum/160) >= this.threshold;
      if (!this.talking) {
        this.pre.push(chunk); if (this.pre.length > 15) this.pre.shift();
        this.voiced = voice ? this.voiced+20 : 0;
        if (this.voiced < 120) continue;
        this.talking = true; this.utteranceId++;this.parts = this.pre.splice(0); this.duration = this.parts.length*20; this.emit('speech');
      } else { this.parts.push(chunk); this.duration+=20; }
      if(voice&&this.previewed){this.previewed=false;this.emit('resume',this.utteranceId);}
      this.silent = voice ? 0 : this.silent+20;
      if(!this.previewed&&this.silent>=this.previewMs){this.previewed=true;this.emit('preview',this.audio(),{id:this.utteranceId});}
      if (this.silent >= this.silenceMs || this.duration >= 20000) {
        const pcm=this.audio(),meta={id:this.utteranceId,silenceMs:this.silent};this.reset();this.emit('utterance',pcm,meta);
      }
    }
  }
}
class Player {
  constructor(socket) { this.socket=socket; this.version=0; }
  stop() { this.version++; clearTimeout(this.timer); if(this.resolve) { const done=this.resolve; this.resolve=null; done(false); } }
  play(pcm) {
    this.stop(); const version=this.version; let offset=0;
    return new Promise(resolve => {
      this.resolve=resolve;
      const send=()=>{
        if(version!==this.version||this.socket.destroyed)return this.stop();
        if(offset>=pcm.length){this.resolve=null;resolve(true);return;}
        if(this.socket.writableLength>3200){this.socket.destroy();this.stop();return;}
        const packet=Buffer.alloc(320);pcm.copy(packet,0,offset,offset+320);offset+=320;
        this.socket.write(frame(0x10,packet));this.timer=setTimeout(send,20);
      };send();
    });
  }
}
module.exports={frame,Parser,uuid,wav,Vad,Player};
