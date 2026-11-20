'use strict';
const fs=require('node:fs/promises'),speech=require('../../server/speech'),{wav}=require('../../server/telephony-audio');
(async()=>{await fs.mkdir('/data/qa',{recursive:true});for(const [i,text]of ['我是本人。','同意。','妈妈恢复得还好。宝宝现在两个月，吃奶睡觉都挺好。','我想找医生。'].entries())await fs.writeFile('/data/qa/answer-'+i+'.wav',wav(await speech.speakPcm(text),8000));console.log('Four synthetic caller audio files ready');})().catch(e=>{console.error(e.message);process.exitCode=1;});
