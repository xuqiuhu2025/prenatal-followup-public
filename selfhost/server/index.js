const fs = require('fs');
// Hospital follow-up: staff API, general guidance and voice service.
const path = require('path');
const express = require('express');

const chat = require('./hospital-chat');
const admin = require('./admin');
const voice = require('./voice');

const PORT = Number(process.env.PORT) || 3000;
// Docker 内：server 文件位于 /app，webapp 位于 /app/webapp；本地开发：server/ 与 ../webapp
const WEBAPP_DIR = process.env.WEBAPP_DIR ||
  (require('fs').existsSync(path.join(__dirname, 'webapp'))
    ? path.join(__dirname, 'webapp')
    : path.join(__dirname, '..', 'webapp'));
const app = express();

app.use('/cs-admin', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '1mb' }));
app.get('/js/patient-validation.js', (req, res) => res.sendFile(path.join(__dirname, 'patient-validation.js')));
app.get('/js/prenatal-data.js', (req, res) => res.sendFile(path.join(__dirname, 'prenatal-data.js')));
app.get('/js/customer-validation.js', (req, res) => res.sendFile(path.join(__dirname, 'customer-validation.js')));

app.post('/cs-chat', async (req, res) => {
  res.json(await chat.main(req.body || {}));
});
app.post('/cs-admin', async (req, res) => {
  res.setHeader('Cache-Control','no-store');
  res.json(await admin.main(req.body || {},{ip:req.socket.remoteAddress}));
});
app.post('/voice', async (req, res) => {
  res.json(await voice.main(req.body || {}));
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// 静态前端（同源，无 CORS）
app.use(express.static(WEBAPP_DIR, { maxAge: '1h', setHeaders(res,file){if(file.endsWith('.html')||file.endsWith('config.js'))res.setHeader('Cache-Control','no-cache');} }));
app.get('/', (req, res) => res.sendFile(path.join(WEBAPP_DIR, 'index.html')));

// 错误兜底
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: '提交数据过大，请拆分后导入' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: '请求数据格式不正确' });
  console.error('server error:', err);
  res.status(500).json({ ok: false, error: '服务内部错误' });
});

async function startServer() {
await require('./hospital').ensureSchema();
await require('./accounts').ensureSchema();
await require('./prenatal').ensureSchema();
await require('./telephony').start();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`smart-cs server listening on :${PORT}`);
});

// HTTPS（自签）：浏览器麦克风 getUserMedia 需要 https 或 localhost
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 0;
if (HTTPS_PORT) {
  const https = require('https');
  const CERT_DIR = process.env.CERT_DIR || '/certs';
  const keyPath = path.join(CERT_DIR, 'selfsigned.key');
  const certPath = path.join(CERT_DIR, 'selfsigned.crt');
  try {
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);
    https.createServer({ key, cert }, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`smart-cs https listening on :${HTTPS_PORT}`);
    });
  } catch (e) {
    console.warn('https disabled (no certs):', e && e.message);
  }
}

}
startServer().catch(err => { console.error('Server initialization failed:', err.message); process.exit(1); });
