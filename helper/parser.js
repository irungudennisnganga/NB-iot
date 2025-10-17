// helper/parser.js
const cbor = require('cbor');
const { crc16 } = require('./crc16');
const Redis = require('ioredis');
const ctl = require('./hacnbh');

// ---- Redis client (lazy global) ----
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

// Helpers
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

function keyFor(sn) {
  return `meter:cmd:${sn}`;
}

/**
 * Parse uplink, validate CRC, decode CBOR, extract meter_data.
 * Then check Redis for command for this meter_sn, execute, and clear the key.
 * @param {string} hex - full outer frame in hex (header + delimiter + CBOR + CRC)
 * @param {string} ip  - rinfo.address from UDP socket
 * @param {number} port - rinfo.port from UDP socket
 * @returns {Promise<{header:object, crcOk:boolean, meter_data:object}>}
 */
async function parseUplink(hex, ip, port) {
  const buf = Buffer.from(hex, 'hex');

  if (buf.length < 12) {
    throw new Error('Too short to be a valid packet');
  }

  // -------- Header parsing --------
  const header = {
    version: buf.slice(0, 2).toString('hex'),
    msgType: buf[2],
    functionCode: buf[3],
    msgId: buf.slice(4, 6).toString('hex'),
    format: buf[6],
    dataLen: buf.readUInt16BE(7)
  };

  // -------- Find delimiter + payload bounds --------
  const delimiterIndex = buf.indexOf(0xFF, 9); // 0xFF = unencrypted, 0xAA = encrypted
  const payloadStart = (delimiterIndex !== -1) ? (delimiterIndex + 1) : 10;
  const payloadEnd = payloadStart + header.dataLen;

  if (buf.length < payloadEnd + 2) {
    throw new Error(`Buffer too short for expected payload length=${header.dataLen}`);
  }

  // -------- CRC16/AUG-CCITT --------
  const dataField = buf.slice(payloadStart, payloadEnd);
  const crcReceived = buf.slice(payloadEnd, payloadEnd + 2).readUInt16BE();
  const crcCalc = crc16(buf.slice(0, payloadEnd));
  if (crcReceived !== crcCalc) {
    throw new Error(`CRC mismatch. Expected ${crcCalc.toString(16)}, got ${crcReceived.toString(16)}`);
  }

  // -------- CBOR decode --------
  let payload;
  try {
    const all = cbor.decodeAllSync(dataField);
    payload = all[0];
  } catch (e) {
    throw new Error(`CBOR decoding failed: ${e.message}`);
  }

  // -------- Structure + extract fields --------
  const structured = bnToStructured(payload);
  const meter_data = {};

  // /3/0 — device info
  if (structured['/3/0']) {
    const v = structured['/3/0'];
    meter_data.meter_sn  = v['2'];
    meter_data.time      = v['13'];
    meter_data.time_zone = v['14'];

    // Battery status mapping (only some codes used by your example)
    if (v['20'] === 0 || v['20'] === '0') meter_data.battery_status = 'battery normal';
    else if (v['20'] === 1 || v['20'] === '1') meter_data.battery_status = 'battery charging';
    else if (v['20'] === 2 || v['20'] === '2') meter_data.battery_status = 'charging finished';
    else if (v['20'] === 3 || v['20'] === '3') meter_data.battery_status = 'battery damaged';
    else if (v['20'] === 4 || v['20'] === '4') meter_data.battery_status = 'low battery';
  }

  // /80/0 — meter basics
  if (structured['/80/0']) {
    const v = structured['/80/0'];
    meter_data.meter_reading       = v['16'];
    meter_data.meter_error_status  = v['6'];
  }

  // /84/0 — delivery
  if (structured['/84/0']) {
    const v = structured['/84/0'];
    meter_data.delivery_frequency = v['0'];
  }

  // /81/0 — valve
  if (structured['/81/0']) {
    const v = structured['/81/0'];
    if (v['1'] === 1 || v['1'] === '1') meter_data.valve_status = 'closed';
    else if (v['1'] === 0 || v['1'] === '0') meter_data.valve_status = 'open';

    // BUGFIX: original code checked values['1'] again — use values['2'] for fault status
    if (v['2'] === 1 || v['2'] === '1') meter_data.valve_faulty_status = 'faulty';
    else if (v['2'] === 0 || v['2'] === '0') meter_data.valve_faulty_status = 'normal';
  }

  // /99/0 — radio info
  if (structured['/99/0']) {
    const v = structured['/99/0'];
    meter_data.imei        = v['1'];
    meter_data.signal_rssi = v['11'];
    meter_data.signal_snr  = v['14'];
  }

  // -------- Command dispatch from Redis for this meter --------
  const sn = meter_data.meter_sn || null;
  if (sn ) {
    try {
      const key = keyFor(sn);
      const raw = await redis.get(key);

      if (raw) {
        const cmd = JSON.parse(raw);
        if(cmd.meter_sn ===sn){
            const c = Number(cmd.command);
        
        console.log(`➡️  Found command for SN=${sn}:`, cmd);
        // optional: include a mid so your CBOR array can include /70/0,2:mid
        const opts = { mid: 0x1907e2 }; // pick any UInt16 you like, or omit

        if (c === 1) {
          console.log(`➡️  Command=1 (close) found for SN=${sn}. Sending valveClose to ${ip}:${port}`);
          ctl.valveClose(ip, port);
        } else if (c === 0) {
          console.log(`➡️  Command=0 (open) found for SN=${sn}. Sending valveOpen to ${ip}:${port}`);
          ctl.valveOpen(ip, port);
        } else {
          console.warn(`⚠️ Unknown command value for SN=${sn}:`, cmd);
        }

        // Remove the command once used
        await redis.del(key);
        }
        
      } else {
        // No command queued — do nothing
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
