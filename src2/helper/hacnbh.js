// helper/hacnbh.js
const cbor = require('cbor');
const dgram = require('dgram');
const { crc16 } = require('./crc16');

let sharedSocket = null;

function attachSocket(sock) {
  sharedSocket = sock;
}

// --- Utility Functions ---
function rand16Pair() {
  const n = Math.floor(Math.random() * 0x10000);
  return [(n >> 8) & 0xff, n & 0xff];
}
function u16(n) {
  return [(n >> 8) & 0xff, n & 0xff];
}
function toIdArr(id) {
  if (id == null) return undefined;
  return Array.isArray(id) ? id : [(id >> 8) & 0xff, id & 0xff];
}
function bnMap(bn, entries) {
  const m = new Map(entries);
  m.set('bn', bn);
  return m;
}

// --- UDP Packet Builder ---
function buildPacket(cborObjects, funcCode, msgType = 0x00, msgId, encrypted = false) {
  const payload = cbor.encode(cborObjects);
  const id = msgId || rand16Pair();
  const header = Buffer.from([
    0x01, 0x01,
    msgType & 0xff,
    funcCode & 0xff,
    id[0], id[1],
    0x3c,
    ...u16(payload.length)
  ]);
  const full = Buffer.concat([header, payload]);
  const crc = Buffer.from(u16(crc16(full)));
  return Buffer.concat([full, crc]);
}

function sendUDP(packet, ip, port, label = 'Packet') {
  if (sharedSocket) {
    sharedSocket.send(packet, port, ip, (err) => {
      if (err) console.error(`❌ ${label} failed:`, err.message);
      else {
        console.log(`✅ ${label} sent to ${ip}:${port}`);
        console.log('HEX:', packet.toString('hex'));
      }
    });
  } else {
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
}

// --- WRITE Command ---
function writeCommand(ip, port, objects, opts = {}) {
  const { msgId, mid } = opts;
  const idArr = toIdArr(msgId);
  const meterId = mid ?? msgId; // fallback to msgId if mid is missing

  const payload = [
    ...objects,
    bnMap('/70/0', [[2, meterId]])
  ];

  const pkt = buildPacket(payload, 0x03, 0x00, idArr);
  sendUDP(pkt, ip, port, 'WRITE');
}

// --- SCHOOLING Command ---
function schoolingCommand(ip, port, objects, opts = {}) {
  const { mid, msgId, encrypted } = opts;
  const idArr = toIdArr(msgId);
  const meterId = mid ?? msgId;

  const payload = [
    ...objects,
    bnMap('/70/0', [[2, meterId]])
  ];

  const pkt = buildPacket(payload, 0x45, 0x02, idArr, !!encrypted);
  sendUDP(pkt, ip, port, 'Schooling');
}

// --- Valve Control ---
function valveOpen(ip, port, opts = {}) {
  writeCommand(ip, port, [bnMap('/81/0', [[0, 0]])], opts);
}
function valveClose(ip, port, opts = {}) {
  writeCommand(ip, port, [bnMap('/81/0', [[0, 1]])], opts);
}
function valveForce(ip, port, action /* 0=open, 1=close */, opts = {}) {
  writeCommand(ip, port, [bnMap('/81/0', [[6, action]])], opts);
}

function valveSend(ip, port, desired /* 'open' | 'close' */, opts = {}) {
  const action = desired === 'open' ? 0 : 1;
  return opts.useForce
    ? valveForce(ip, port, action, opts)
    : (desired === 'open' ? valveOpen(ip, port, opts) : valveClose(ip, port, opts));
}

// --- Other Commands ---
function setTimeUTC(ip, port, tz = 'UTC+0', opts = {}) {
  const ts = Math.floor(Date.now() / 1000);
  schoolingCommand(ip, port, [bnMap('/3/0', [[13, ts], [14, tz]])], opts);
}
function setActiveAlarmReporting(ip, port, mode /* 0|1|2 */, opts = {}) {
  writeCommand(ip, port, [bnMap('/80/0', [[56, mode]])], opts);
}
function setBluetooth(ip, port, enable, opts = {}) {
  writeCommand(ip, port, [bnMap('/80/0', [[67, enable ? 1 : 0]])], opts);
}
function queryNBInfo(ip, port, opts = {}) {
  writeCommand(ip, port, [bnMap('/99/0', [[20, 1]])], opts);
}
function readFrozenDay(ip, port, yymmdd, opts = {}) {
  writeCommand(ip, port, [bnMap('/80/0', [[28, yymmdd]])], opts);
}
function readFrozenLatest(ip, port, opts = {}) {
  writeCommand(ip, port, [bnMap('/80/0', [[19, 0]])], opts);
}
function queryMeterInfo(ip, port, opts = {}) {
  writeCommand(ip, port, [bnMap('/80/0', [[40, 1]])], opts);
}

// --- Export API ---
module.exports = {
  attachSocket,
  bnMap,
  buildPacket,
  sendUDP,
  writeCommand,
  schoolingCommand,
  valveSend,
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
