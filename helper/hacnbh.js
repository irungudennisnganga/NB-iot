// helper/hacnbh.js
const cbor = require('cbor');
const dgram = require('dgram');
const { crc16 } = require('./crc16');

let sharedSocket = null;

// Attach UDP socket from index.js (so we keep same 4-tuple)
function attachSocket(sock) {
  sharedSocket = sock;
}

// utils
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

/** Keep numeric keys by using Map */
function bnMap(bn, entries) {
  const m = new Map(entries);
  m.set('bn', bn);
  return m;
}

/** Build HAC-NBh frame (header + CBOR + CRC16/AUG-CCITT) */
function buildPacket(cborObjects, funcCode, msgType = 0x00, msgId, encrypted = false) {
  const payload = cbor.encode(cborObjects);
  const id = msgId || rand16Pair();

  const header = Buffer.from([
    0x01, 0x01,                 // version 1.01
    msgType & 0xff,             // msg type
    funcCode & 0xff,            // func code
    id[0], id[1],               // msg id
    0x3c,                       // format = CBOR
    ...u16(payload.length),     // data length
    encrypted ? 0xaa : 0xff     // delimiter (no-encrypt=FF)
  ]);

  const full = Buffer.concat([header, payload]);
  const crc = Buffer.from(u16(crc16(full)));
  return Buffer.concat([full, crc]);
}

/** Send via UDP (reuse sharedSocket) */
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
  // fallback (shouldn’t be needed if you attached)
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

/** WRITE/config (func=0x03). Adds /70/0,2:<mid> when opts.mid provided. */
function writeCommand(ip, port, objects, opts = {}) {
  const { mid, msgId, encrypted } = opts;
  const idArr = toIdArr(msgId);
  const payload = mid != null ? [...objects, bnMap('/70/0', [[2, mid]])] : objects;
  const pkt = buildPacket(payload, 0x03, 0x00, idArr, !!encrypted);
  sendUDP(pkt, ip, port, 'Config (WRITE)');
}

/** Schooling (func=0x45, msgType=0x02) */
function schoolingCommand(ip, port, objects, opts = {}) {
  const { mid, msgId, encrypted } = opts;
  const idArr = toIdArr(msgId);
  const payload = mid != null ? [...objects, bnMap('/70/0', [[2, mid]])] : objects;
  const pkt = buildPacket(payload, 0x45, 0x02, idArr, !!encrypted);
  sendUDP(pkt, ip, port, 'Schooling');
}

// --------- high-level helpers ---------
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

// Time calibration (schooling): /3/0, keys 13 Unix, 14 TZ string
function setTimeUTC(ip, port, tz = 'UTC+0', opts = {}) {
  const ts = Math.floor(Date.now() / 1000);
  schoolingCommand(ip, port, [ bnMap('/3/0', [[13, ts], [14, tz]]) ], opts);
}

// Examples used elsewhere
function setActiveAlarmReporting(ip, port, mode /* 0|1|2 */, opts = {}) {
  writeCommand(ip, port, [ bnMap('/80/0', [[56, mode]]) ], opts);
}
function setBluetooth(ip, port, enable, opts = {}) {
  writeCommand(ip, port, [ bnMap('/80/0', [[67, enable ? 1 : 0]]) ], opts);
}
function queryNBInfo(ip, port, opts = {}) {
  writeCommand(ip, port, [ bnMap('/99/0', [[20, 1]]) ], opts);
}
function readFrozenDay(ip, port, yymmdd, opts = {}) {
  writeCommand(ip, port, [ bnMap('/80/0', [[28, yymmdd]]) ], opts);
}
function readFrozenLatest(ip, port, opts = {}) {
  writeCommand(ip, port, [ bnMap('/80/0', [[19, 0]]) ], opts);
}
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
