// index.js
const dgram = require('dgram');
const express = require('express');
const ctl = require('./helper/hacnbh');
const { parseUplink } = require('./helper/parser');
const Redis = require('ioredis');

const app = express();
app.use(express.json());

// ---- HTTP API (queue commands) ----
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const CMD_TTL_SECONDS = 300;
const keyFor = (sn) => `meter:cmd:${sn}`;

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/commands/health', (req, res) => res.json({ ok: true }));

app.post('/commands', async (req, res) => {
  try {
    const { meter_sn, command } = req.body || {};
    if (!meter_sn || ![0, 1, 2, '0', '1', '2'].includes(command)) {
      return res.status(400).json({ ok: false, error: 'Invalid payload. Expect: { meter_sn, command: 0|1|2 }' });
    }
    const key = keyFor(meter_sn);
    await redis.del(key); // drop previous pending command for this meter
    const payload = JSON.stringify({ meter_sn, command: Number(command), created_at: Date.now() });
    if (CMD_TTL_SECONDS > 0) {
      await redis.set(key, payload, 'EX', CMD_TTL_SECONDS);
    } else {
      await redis.set(key, payload);
    }
    return res.json({ ok: true, key, ttl: CMD_TTL_SECONDS });
  } catch (err) {
    console.error('POST /commands error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/commands/:meter_sn', async (req, res) => {
  try {
    const raw = await redis.get(keyFor(req.params.meter_sn));
    return res.json({ ok: true, command: raw ? JSON.parse(raw) : null });
  } catch (err) {
    console.error('GET /commands error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.listen(4545, () => {
  console.log('HTTP server listening on http://0.0.0.0:4545');
});

// ---- UDP server ----
const socket = dgram.createSocket('udp4');

// attach AFTER we bind & are listening
socket.on('listening', () => {
  const addr = socket.address();
  console.log(`UDP server listening on ${addr.address}:${addr.port}`);
  ctl.attachSocket(socket);
});

socket.on('error', (err) => {
  console.error('❌ UDP socket error:', err);
});

socket.on('message', async (msg, rinfo) => {
  console.log(`📨 UPLINK from ${rinfo.address}:${rinfo.port}`);
  try {
    // Detect ASCII-hex vs raw
    const utf8 = msg.toString('utf8');
    const asciiHex = utf8.length >= 24 && (utf8.length % 2 === 0) && /^[0-9a-fA-F]+$/.test(utf8);
    const hex = asciiHex ? utf8 : msg.toString('hex');

    const parsed = await parseUplink(hex, rinfo.address, rinfo.port);
    const h = parsed?.header || {};
    console.log('✅ Parsed summary:', {
      bytes: hex.length / 2,
      from: `${rinfo.address}:${rinfo.port}`,
      msgType: h.msgType,
      functionCode: h.functionCode,
      msgId: h.msgId,
      crcOk: parsed?.crcOk,
      parsed,
    });

  } catch (e) {
    console.error('❌ Error parsing uplink:', e.message);
  }
});

// bind first → attach in 'listening'
socket.bind(10005, '0.0.0.0');
