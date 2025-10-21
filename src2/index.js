// index.js
const express = require('express');
const Redis = require('ioredis');
const { bindUDP, lastHopBySN } = require('./udpSocket'); // centralized UDP handler
const ctl = require('./helper/hacnbh');

const app = express();
app.use(express.json());

// Start the UDP socket
bindUDP(10005);

// ---- HTTP API logic below ----
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const CMD_TTL_SECONDS = 300;
const keyFor = (sn) => `meter:cmd:${sn}`;

app.post('/commands', async (req, res) => {
  try {
    const { meter_sn, command, useForce } = req.body || {};
    if (!meter_sn || ![0,1,2,'0','1','2'].includes(command)) {
      return res.status(400).json({ ok:false, error: 'payload: { meter_sn, command:0|1|2, useForce?: true }' });
    }
    const payload = JSON.stringify({
      meter_sn,
      command: Number(command),
      useForce: !!useForce,
      created_at: Date.now(),
      status: 'queued',
      attempts: 0,
    });
    const key = keyFor(meter_sn);
    await redis.del(key);
    await redis.set(key, payload, 'EX', CMD_TTL_SECONDS);
    res.json({ ok: true, key, ttl: CMD_TTL_SECONDS });
  } catch (err) {
    console.error('POST /commands error:', err);
    res.status(500).json({ ok:false, error:'server error' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(4545, () => {
  console.log('🚀 HTTP server on http://0.0.0.0:4545');
});
