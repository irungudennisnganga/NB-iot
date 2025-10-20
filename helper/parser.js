const cbor = require('cbor');
const { crc16 } = require('./crc16');
const Redis = require('ioredis');
const EventEmitter = require('events');
const ctl = require('./hacnbh');

// ─── Redis ─────────────────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const keyFor = (sn) => `meter:cmd:${sn}`;

// ─── Helpers ───────────────────────────────────────────────────────────────────
function bnToStructured(payload) {
  const structured = {};
  for (const entry of payload) {
    const bn = entry.get && entry.get('bn');
    if (!bn) continue;
    const obj = {};
    for (const [k, v] of entry.entries()) {
      if (k !== 'bn') obj[k] = v;
    }
    structured[bn] = obj;
  }
  return structured;
}

function rand16() {
  return Math.floor(Math.random() * 0x10000) & 0xffff;
}
function numToHex16(n) {
  return n.toString(16).padStart(4, '0');
}

// ─── ACK bus (device responses 0x44) ───────────────────────────────────────────
const ackBus = new EventEmitter();
ackBus.setMaxListeners(1000);

function awaitAck(msgIdHex, timeoutMs = 3500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    function onAck(payload) {
      cleanup();
      resolve(payload);
    }
    function cleanup() {
      clearTimeout(timer);
      ackBus.removeListener(`ack:${msgIdHex}`, onAck);
    }

    ackBus.on(`ack:${msgIdHex}`, onAck);
  });
}

/** Send once, wait for 0x44 ACK by msgId, retry up to N times if needed. */
async function sendWithAckRetry(sendFn, retries = 2, ackTimeoutMs = 3500, retryGapMs = 1500) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const msgIdNum = rand16();
    const msgIdHex = numToHex16(msgIdNum);

    await sendFn(msgIdNum);                       // must send using this msgId
    const ack = await awaitAck(msgIdHex, ackTimeoutMs);
    if (ack) return { ok: true, msgIdHex, ack };

    if (attempt < retries) await new Promise(r => setTimeout(r, retryGapMs));
  }
  return { ok: false };
}

/**
 * Parse uplink, validate CRC, decode CBOR, extract meter_data.
 * If funcCode==0x44: emit ACK and return.
 * Otherwise: check Redis for {meter:cmd:<sn>} and send ONE command with ACK+retry.
 */
async function parseUplink(hex, ip, port) {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length < 12) throw new Error('Too short to be a valid packet');

  // Header
  const header = {
    version: buf.slice(0, 2).toString('hex'),
    msgType: buf[2],
    functionCode: buf[3],
    msgId: buf.slice(4, 6).toString('hex'),
    format: buf[6],
    dataLen: buf.readUInt16BE(7)
  };

  // Delimiter (FF or AA) & payload bounds
  const iFF = buf.indexOf(0xFF, 9);
  const iAA = buf.indexOf(0xAA, 9);
  const firstDelim = [iFF, iAA].filter(i => i >= 0).sort((a,b)=>a-b)[0];
  const payloadStart = (firstDelim != null) ? (firstDelim + 1) : 10;
  const payloadEnd = payloadStart + header.dataLen;
  if (buf.length < payloadEnd + 2) {
    throw new Error(`Buffer too short for expected payload length=${header.dataLen}`);
  }

  // CRC16/AUG-CCITT
  const dataField = buf.slice(payloadStart, payloadEnd);
  const crcReceived = buf.slice(payloadEnd, payloadEnd + 2).readUInt16BE();
  const crcCalc = crc16(buf.slice(0, payloadEnd));
  if (crcReceived !== crcCalc) {
    throw new Error(`CRC mismatch. Expected ${crcCalc.toString(16)}, got ${crcReceived.toString(16)}`);
  }

  // CBOR
  let payload;
  try {
    const all = cbor.decodeAllSync(dataField);
    payload = all[0];
  } catch (e) {
    throw new Error(`CBOR decoding failed: ${e.message}`);
  }

  // Structured + extraction
  const structured = bnToStructured(payload);
  const meter_data = {};

  if (structured['/3/0']) {
    const v = structured['/3/0'];
    meter_data.meter_sn  = v['2'];
    meter_data.time      = v['13'];
    meter_data.time_zone = v['14'];
    if (v['20'] === 0 || v['20'] === '0') meter_data.battery_status = 'battery normal';
    else if (v['20'] === 1 || v['20'] === '1') meter_data.battery_status = 'battery charging';
    else if (v['20'] === 2 || v['20'] === '2') meter_data.battery_status = 'charging finished';
    else if (v['20'] === 3 || v['20'] === '3') meter_data.battery_status = 'battery damaged';
    else if (v['20'] === 4 || v['20'] === '4') meter_data.battery_status = 'low battery';
  }

  if (structured['/80/0']) {
    const v = structured['/80/0'];
    meter_data.meter_reading       = v['16'];
    meter_data.meter_error_status  = v['6'];
  }

  if (structured['/84/0']) {
    const v = structured['/84/0'];
    meter_data.delivery_frequency = v['0'];
  }

  if (structured['/81/0']) {
    const v = structured['/81/0'];
    if (v['1'] === 1 || v['1'] === '1') meter_data.valve_status = 'closed';
    else if (v['1'] === 0 || v['1'] === '0') meter_data.valve_status = 'open';

    if (v['2'] === 1 || v['2'] === '1') meter_data.valve_faulty_status = 'faulty';
    else if (v['2'] === 0 || v['2'] === '0') meter_data.valve_faulty_status = 'normal';
  }

  if (structured['/99/0']) {
    const v = structured['/99/0'];
    meter_data.imei        = v['1'];
    meter_data.signal_rssi = v['11'];
    meter_data.signal_snr  = v['14'];
  }

  // If device response (0x44), emit ACK and return
  if (header.functionCode === 0x44) {
    ackBus.emit(`ack:${header.msgId}`, { structured, meter_data });
    return { header, crcOk: true, meter_data };
  }

  // Otherwise, normal uplink: check Redis command for this SN
  const sn = meter_data.meter_sn || null;
  if (sn) {
    try {
      const key = keyFor(sn);
      const raw = await redis.get(key);
      if (raw) {
        const cmd = JSON.parse(raw);
        const c = Number(cmd.command);

        const result = await sendWithAckRetry(async (msgIdNum) => {
          const opts = { msgId: msgIdNum };
          if (c === 1) {
            console.log(`➡️  Command=1 (close) for SN=${sn}. Sending (msgId=${numToHex16(msgIdNum)}) to ${ip}:${port}`);
            ctl.valveClose(ip, port, opts);       // key 0 = 1
          } else if (c === 0) {
            console.log(`➡️  Command=0 (open) for SN=${sn}. Sending (msgId=${numToHex16(msgIdNum)}) to ${ip}:${port}`);
            ctl.valveOpen(ip, port, opts);        // key 0 = 0
          }else if(c ===2){
            console.log(`➡️  Command=2 (query NB info) for SN=${sn}. Sending (msgId=${numToHex16(msgIdNum)}) to ${ip}:${port}`);
            ctl.queryNBInfo(ip, port, opts);

            
          } else {
            console.warn(`⚠️ Unknown command for SN=${sn}:`, cmd);
          }
        });

        if (result.ok) {
          console.log(`✅ ACK 0x44 received for msgId=${result.msgIdHex} (SN=${sn})`);
          await redis.del(key); // consume command on success
        } else {
          console.warn(`⏱️  No ACK after retries (SN=${sn}). Leaving command in Redis for next uplink.`);
          // Optionally delete if you don't want to retry on next uplink:
          // await redis.del(key);
        }
      }
    } catch (err) {
      console.error('❌ Redis command dispatch error:', err);
    }
  } else {
    console.warn('⚠️ No meter_sn extracted; skipping Redis command lookup.');
  }

  return { header, crcOk: true, meter_data };
}

module.exports = { parseUplink };
