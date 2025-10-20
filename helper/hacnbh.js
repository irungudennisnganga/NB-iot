// helper/hacnbh.js
const cbor = require('cbor');
const dgram = require('dgram');
const { crc16 } = require('./crc16');

let sharedSocket = null;

// Attach a UDP socket created elsewhere (index.js)
function attachSocket(sock) {
  sharedSocket = sock;
}

// ---------- small utils ----------
function rand16Pair() {
  const n = Math.floor(Math.random() * 0x10000);
  return [ (n >> 8) & 0xff, n & 0xff ];
}
function u16(n) {
  return [ (n >> 8) & 0xff, n & 0xff ];
}
function toIdArr(id) {
  if (id == null) return undefined;
  if (Array.isArray(id)) return id;
  return [ (id >> 8) & 0xff, id & 0xff ];
}

/**
 * Keep numeric keys in CBOR by using a Map.
 * @param {string} bn - base name (/xx/x)
 * @param {Array<[number|string, any]>} entries - numeric keys like [[0,1],[56,2],...]
 */
function bnMap(bn, entries) {
  const m = new Map(entries);
  m.set('bn', bn);
  return m;
}

/**
 * Build a HAC-NBh frame (header + CBOR + CRC16/AUG-CCITT).
 * @param {Array<object|Map>} cborObjects
 * @param {number} funcCode      0x03 (WRITE/config) or 0x45 (Schooling)
 * @param {number} [msgType=0x00] 0x00 for WRITE, 0x02 for Schooling
 * @param {number[]|undefined} msgId [hi,lo] (or omit to auto-generate)
 * @param {boolean} [encrypted=false] false => 0xFF, true => 0xAA (delimiter only; no AES here)
 */
function buildPacket(cborObjects, funcCode, msgType = 0x00, msgId, encrypted = false) {
  const payload = cbor.encode(cborObjects);
  const id = msgId || rand16Pair();

  const header = Buffer.from([
    0x01, 0x01,                 // Version 1.01
    msgType & 0xff,             // Message Type
    funcCode & 0xff,            // Function Code
    id[0], id[1],               // Message ID
    0x3c,                       // Format: CBOR
    ...u16(payload.length),     // Data length
    encrypted ? 0xaa : 0xff     // Delimiter (no-encrypt=FF, AES=AA but not performed here)
  ]);

  const full = Buffer.concat([header, payload]);
  const crc = Buffer.from(u16(crc16(full)));
  return Buffer.concat([full, crc]);
}

/** Send via UDP (prefer shared socket so the 4-tuple stays stable). */
function sendUDP(packet, ip, port, label = 'Packet') {
  if (sharedSocket) {
    sharedSocket.send(packet, port, ip, (err) => {
      if (err) {
        console.error(`❌ ${label} failed:`, err.message);
      } else {
        console.log(`✅ ${label} sent to ${ip}:${port}`);
        console.log('HEX:', packet.toString('hex'));
      }
    });
    return;
  }

  // Fallback: ephemeral socket only if no shared socket is attached.
  const sock = dgram.createSocket('udp4');
  sock.send(packet, port, ip, (err) => {
    if (err) console.error(`❌ ${label} failed:`, err.message);
    else {
      console.log(`✅ ${label} sent to ${ip}:${port}`);
      console.log('HEX:', packet.toString('hex'));
    }
    sock.close();
  });
}

/**
 * WRITE/config helper (func=0x03).
 * If opts.mid is provided, we append { bn:'/70/0', 2: mid } as a 2nd map (matches vendor samples).
 * Accepts opts.msgId as number or [hi,lo] so your retry/ACK flow matches the sent frame.
 */
function writeCommand(ip, port, objects, opts = {}) {
  const { mid, msgId, encrypted } = opts;
  const idArr = toIdArr(msgId); // allow number or [hi, lo]
  const payload = mid != null ? [...objects, bnMap('/70/0', [[2, mid]])] : objects;
  const pkt = buildPacket(payload, 0x03, 0x00, idArr, !!encrypted);
  sendUDP(pkt, ip, port, 'Config (WRITE)');
}

/**
 * Schooling helper (func=0x45, msgType=0x02).
 */
function schoolingCommand(ip, port, objects, opts = {}) {
  const { mid, msgId, encrypted } = opts;
  const idArr = toIdArr(msgId);
  const payload = mid != null ? [...objects, bnMap('/70/0', [[2, mid]])] : objects;
  const pkt = buildPacket(payload, 0x45, 0x02, idArr, !!encrypted);
  sendUDP(pkt, ip, port, 'Schooling');
}

// ---------------- High-level commands ----------------

// Valve control: /81/0, key 0 → 0=open, 1=close
function valveOpen(ip, port, opts = {}) {
  writeCommand(ip, port, [ bnMap('/81/0', [[0, 0]]) ], opts);
}
function valveClose(ip, port, opts = {}) {
  writeCommand(ip, port, [ bnMap('/81/0', [[0, 1]]) ], opts);
}

// Force valve (prepaid): /81/0, key 6 → 0 open, 1 close, 2 cancel
function valveForce(ip, port, action /* 0|1|2 */, opts = {}) {
  writeCommand(ip, port, [ bnMap('/81/0', [[6, action]]) ], opts);
}

// Time calibration (schooling): /3/0, keys 13 (Unix) & 14 (UTC string)
function setTimeUTC(ip, port, tz = 'UTC+0', opts = {}) {
  const ts = Math.floor(Date.now() / 1000);
  schoolingCommand(ip, port, [ bnMap('/3/0', [[13, ts], [14, tz]]) ], opts);
}

// Alarm reporting: /80/0, key 56 → 0 off, 1 every, 2 first-of-day
function setActiveAlarmReporting(ip, port, mode /* 0|1|2 */, opts = {}) {
  writeCommand(ip, port, [ bnMap('/80/0', [[56, mode]]) ], opts);
}

// Bluetooth: /80/0, key 67 → 0 disable, 1 enable
function setBluetooth(ip, port, enable, opts = {}) {
  writeCommand(ip, port, [ bnMap('/80/0', [[67, enable ? 1 : 0]]) ], opts);
}

// Query NB module info: /99/0, key 20 → 1
function queryNBInfo(ip, port, opts = {}) {
  writeCommand(ip, port, [ bnMap('/99/0', [[20, 1]]) ], opts);
}

// Frozen data: /80/0, key 28 (YYMMDD or YYMM) or key 19 (0 latest)
function readFrozenDay(ip, port, yymmdd, opts = {}) {
  writeCommand(ip, port, [ bnMap('/80/0', [[28, yymmdd]]) ], opts);
}
function readFrozenLatest(ip, port, opts = {}) {
  writeCommand(ip, port, [ bnMap('/80/0', [[19, 0]]) ], opts);
}

// Query meter info: /80/0, key 40 → 1
function queryMeterInfo(ip, port, opts = {}) {
  writeCommand(ip, port, [ bnMap('/80/0', [[40, 1]]) ], opts);
}

module.exports = {
  attachSocket,
  bnMap,
  buildPacket,
  writeCommand,
  schoolingCommand,
  valveOpen,
  valveClose,
  valveForce,
  setTimeUTC,
  setActiveAlarmReporting,
  setBluetooth,
  queryNBInfo,
  readFrozenDay,
  readFrozenLatest,
  queryMeterInfo,
};
