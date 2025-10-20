// index.js
const dgram = require('dgram');
const express = require('express');
const Redis = require('ioredis');
const { parseUplink } = require('./helper/parser');
const ctl = require('./helper/hacnbh');

const app = express();
app.use(express.json());

// ---- UDP socket ----
const socket = dgram.createSocket('udp4');
ctl.attachSocket(socket); // downlinks reuse this socket

socket.on('listening', () => {
  const addr = socket.address();
  console.log(`UDP server listening on ${addr.address}:${addr.port}`);
});
socket.on('error', (err) => {
  console.error('❌ UDP socket error:', err);
});

// Smart SN extractor (works with our parser shape)
function extractSN(parsed) {
  return (
    parsed?.meter_data?.meter_sn ??
    parsed?.sn ?? parsed?.SN ??
    parsed?.serial ?? parsed?.serialNumber ??
    parsed?.deviceSN ?? parsed?.device?.sn ?? parsed?.dev?.sn ??
    parsed?.['/3/0']?.[2] ?? null
  );
}

// Simple last hop (optional)
const lastHopBySN = new Map();

socket.on('message', async (msg, rinfo) => {
  console.log(`📨 UPLINK from ${rinfo.address}:${rinfo.port}`);

  try {
    // detect ascii-hex vs binary
    const utf8 = msg.toString('utf8');
    const asciiHex = (utf8.length >= 24 && utf8.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(utf8));
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

    const sn = extractSN(parsed);
    if (sn) {
      lastHopBySN.set(String(sn), { ip: rinfo.address, port: rinfo.port, seenAt: Date.now() });
      console.log(`🔗 Route learned: SN=${sn} -> ${rinfo.address}:${rinfo.port}`);
    } else {
      console.warn('⚠️ SN not found; route not cached.');
    }
  } catch (e) {
    console.error('❌ Error parsing uplink:', e.message);
  }
});

// Bind UDP
socket.bind(10005);

// ---- HTTP API (Redis commands queue) ----
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const CMD_TTL_SECONDS = 300;
const keyFor = (sn) => `meter:cmd:${sn}`;

app.get('/commands/health', (req, res) => res.json({ ok: true }));

// body: { meter_sn: string, command: 0|1|2, useForce?: true }
app.post('/commands', async (req, res) => {
  try {
    const { meter_sn, command, useForce } = req.body || {};
    if (!meter_sn || ![0,1,2,'0','1','2'].includes(command)) {
      return res.status(400).json({ ok:false, error: 'payload: { meter_sn, command:0|1|2, useForce?: true }' });
    }
    const payload = JSON.stringify({
      meter_sn,
      command: Number(command),       // 0=open, 1=close, 2=queryNB
      useForce: !!useForce,           // will switch to /81/0 key 6
      created_at: Date.now(),
      status: 'queued',
      attempts: 0,
    });
    const key = keyFor(meter_sn);
    await redis.del(key);
    if (CMD_TTL_SECONDS > 0) await redis.set(key, payload, 'EX', CMD_TTL_SECONDS);
    else await redis.set(key, payload);
    res.json({ ok: true, key, ttl: CMD_TTL_SECONDS });
  } catch (err) {
    console.error('POST /commands error:', err);
    res.status(500).json({ ok:false, error:'server error' });
  }
});

app.get('/commands/:meter_sn', async (req, res) => {
  try {
    const raw = await redis.get(keyFor(req.params.meter_sn));
    res.json({ ok: true, command: raw ? JSON.parse(raw) : null });
  } catch (err) {
    console.error('GET /commands error:', err);
    res.status(500).json({ ok:false, error:'server error' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(4545, () => {
  console.log('HTTP server listening on http://0.0.0.0:4545');
});
