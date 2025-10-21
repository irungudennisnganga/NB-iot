// helper/parser.js
const cbor = require('cbor');
const Redis = require('ioredis');
const EventEmitter = require('events');
const { crc16 } = require('./crc16');
const ctl = require('./hacnbh');

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const keyFor = (sn) => `meter:cmd:${sn}`;
const CMD_TTL_SECONDS = 300;

const ackBus = new EventEmitter();
ackBus.setMaxListeners(1000);

function rand16() {
  return Math.floor(Math.random() * 0x10000) & 0xffff;
}
function hex16(n) {
  return n.toString(16).padStart(4, '0');
}
function bnToStructured(payload) {
  const out = {};
  for (const entry of payload) {
    const bn = entry.get?.('bn');
    if (!bn) continue;
    const obj = {};
    for (const [k, v] of entry.entries()) {
      if (k !== 'bn') obj[k] = v;
    }
    out[bn] = obj;
  }
  return out;
}

function awaitAck(msgIdHex, timeoutMs = 3500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const onAck = (payload) => {
      cleanup();
      resolve(payload);
    };
    function cleanup() {
      clearTimeout(timer);
      ackBus.removeListener(`ack:${msgIdHex}`, onAck);
    }
    ackBus.on(`ack:${msgIdHex}`, onAck);
  });
}

async function sendWithAckRetry(sendFn, onAttempt, retries = 2, ackTimeoutMs = 3500, retryGapMs = 1500) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const msgIdNum = rand16();
    const msgIdHex = hex16(msgIdNum);
    await onAttempt?.(attempt, msgIdNum, msgIdHex);
    await sendFn(msgIdNum);
    const ack = await awaitAck(msgIdHex, ackTimeoutMs);
    if (ack) return { ok: true, msgIdHex, ack };
    if (attempt < retries) await new Promise((r) => setTimeout(r, retryGapMs));
  }
  return { ok: false };
}

async function readCmd(sn) {
  const raw = await redis.get(keyFor(sn));
  return raw ? JSON.parse(raw) : null;
}
async function writeCmd(sn, obj) {
  const payload = JSON.stringify(obj);
  if (CMD_TTL_SECONDS > 0) {
    await redis.set(keyFor(sn), payload, 'EX', CMD_TTL_SECONDS);
  } else {
    await redis.set(keyFor(sn), payload);
  }
}
async function markSending(sn, cmd, attempt, msgIdNum) {
  await writeCmd(sn, {
    ...cmd,
    status: 'sending',
    attempts: (cmd.attempts || 0) + 1,
    last_msgId: msgIdNum,
    last_msgId_hex: hex16(msgIdNum),
    last_send_at: Date.now(),
  });
}
async function markAcked(sn, cmd, msgIdHex, ackPayload) {
  await writeCmd(sn, {
    ...cmd,
    status: 'acked',
    acked_at: Date.now(),
    last_msgId_hex: msgIdHex,
    last_ack: ackPayload || { note: 'acked' },
  });
}
async function markNoAck(sn, cmd) {
  await writeCmd(sn, {
    ...cmd,
    status: 'no_ack',
    last_result_at: Date.now(),
  });
}

async function parseUplink(hex, ip, port, socket) {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length < 12) throw new Error('Too short');

  const header = {
    version: buf.slice(0, 2).toString('hex'),
    msgType: buf[2],
    functionCode: buf[3],
    msgId: buf.slice(4, 6).toString('hex'),
    format: buf[6],
    dataLen: buf.readUInt16BE(7),
  };

  const iFF = buf.indexOf(0xFF, 9);
  const iAA = buf.indexOf(0xAA, 9);
  const firstDelim = [iFF, iAA].filter(i => i >= 0).sort((a, b) => a - b)[0];
  const payloadStart = firstDelim != null ? firstDelim + 1 : 10;
  const payloadEnd = payloadStart + header.dataLen;

  if (buf.length < payloadEnd + 2)
    throw new Error(`Buffer too short for expected payload length=${header.dataLen}`);

  const dataField = buf.slice(payloadStart, payloadEnd);
  const crcReceived = buf.slice(payloadEnd, payloadEnd + 2).readUInt16BE();
  const crcCalc = crc16(buf.slice(0, payloadEnd));
  if (crcReceived !== crcCalc)
    throw new Error(`CRC mismatch exp=${crcCalc.toString(16)} got=${crcReceived.toString(16)}`);

  let payload;
  try {
    payload = cbor.decodeAllSync(dataField)[0];
  } catch (e) {
    throw new Error(`CBOR decode failed: ${e.message}`);
  }

  const structured = bnToStructured(payload);
  const meter_data = {};

  if (structured['/3/0']) {
    const v = structured['/3/0'];
    meter_data.meter_sn = v['2'];
    meter_data.time = v['13'];
    meter_data.time_zone = v['14'];
    meter_data.battery_status = {
      '0': 'battery normal',
      '1': 'battery charging',
      '2': 'charging finished',
      '3': 'battery damaged',
      '4': 'low battery',
    }[v['20']] || 'unknown';
  }

  if (structured['/80/0']) {
    const v = structured['/80/0'];
    meter_data.meter_reading = v['16'];
    meter_data.meter_error_status = v['6'];
  }

  if (structured['/84/0']) {
    meter_data.delivery_frequency = structured['/84/0']['0'];
  }

  if (structured['/81/0']) {
    const v = structured['/81/0'];
    meter_data.valve_status = (v['1'] == 1) ? 'closed' : 'open';
    meter_data.valve_faulty_status = (v['2'] == 1) ? 'faulty' : 'normal';
  }

  if (structured['/99/0']) {
    const v = structured['/99/0'];
    meter_data.imei = v['1'];
    meter_data.signal_rssi = v['11'];
    meter_data.signal_snr = v['14'];
  }

  if (header.functionCode === 0x44) {
    ackBus.emit(`ack:${header.msgId}`, { structured, meter_data });
    return { header, crcOk: true, meter_data };
  }

  const sn = meter_data.meter_sn || null;
  if (!sn) {
    console.warn('⚠️ No meter_sn extracted; skipping Redis command lookup.');
    return { header, crcOk: true, meter_data };
  }

  try {
    const cmd = await readCmd(sn);
    if (cmd) {
      const c = Number(cmd.command);
      const want = c === 0 ? 'open' : c === 1 ? 'close' : null;

      if (want && meter_data.valve_status) {
        const isTarget = (want === 'open' && meter_data.valve_status === 'open') ||
                         (want === 'close' && meter_data.valve_status === 'closed');
        if (isTarget) {
          await markAcked(sn, cmd, '(optimistic)', { note: 'state matched on uplink' });
          return { header, crcOk: true, meter_data };
        }
      }

      const result = await sendWithAckRetry(
        async (msgIdNum) => {
          const opts = { msgId: msgIdNum, mid: msgIdNum };
          if (c === 1) ctl.valveSend(ip, port, 'close', opts, socket);
          else if (c === 0) ctl.valveSend(ip, port, 'open', opts, socket);
          else if (c === 2) ctl.queryNBInfo(ip, port, opts, socket);
        },
        async (attempt, msgIdNum) => {
          await markSending(sn, cmd, attempt, msgIdNum);
        }
      );

      if (result.ok) {
        console.log(`✅ ACK 0x44 received for msgId=${result.msgIdHex} (SN=${sn})`);
        await markAcked(sn, await readCmd(sn) || cmd, result.msgIdHex, result.ack);
      } else {
        console.warn(`⏱️ No 0x44 after retries (SN=${sn})`);
        await markNoAck(sn, await readCmd(sn) || cmd);
      }
    }
  } catch (err) {
    console.error('❌ Redis command dispatch error:', err);
  }

  return { header, crcOk: true, meter_data };
}

module.exports = {
  parseUplink,
  ackBus,
};
