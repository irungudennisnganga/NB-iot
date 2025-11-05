// hacnbh.js
const cbor = require('cbor');
const dgram = require('dgram');
const { crc16 } = require('./crc16');

let sharedSocket = null; // ← will be set from index.js

function attachSocket(sock) {
  sharedSocket = sock;
}

// Helpers...
function rand16() { const n = Math.floor(Math.random() * 0x10000); return [n >> 8, n & 0xff]; }
function u16(n) { return [ (n >> 8) & 0xff, n & 0xff ]; }

function buildPacket(cborObjects, funcCode, msgType = 0x00, msgId, encrypted = false) {
  const payload = cbor.encode(cborObjects);
  const id = msgId || rand16();
  const header = Buffer.from([
    0x01, 0x01,
    msgType & 0xff,
    funcCode & 0xff,
    id[0], id[1],
    0x3c,
    ...u16(payload.length),
  ]);
  const full = Buffer.concat([header, payload]);
  const crc = Buffer.from(u16(crc16(full)));
  return Buffer.concat([full, crc]);
}

/** Send via UDP, reusing shared socket if available */
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

  // Fallback: ephemeral socket (only if no shared one attached)
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

// High-level helpers (unchanged) …
function writeCommand(ip, port, objects) {
  const pkt = buildPacket(objects, 0x03);
  sendUDP(pkt, ip, port);
}
function schoolingCommand(ip, port, objects) {
  const pkt = buildPacket(objects, 0x45);
  sendUDP(pkt, ip, port, 'Schooling');
}
function valveOpen(ip, port) { writeCommand(ip, port, [{ bn: '/81/0', 0: 0 }]); }
function valveClose(ip, port) { writeCommand(ip, port, { bn: '/81/0', 0: 1 }); }
function valveForce(ip, port, action) { writeCommand(ip, port, [{ bn: '/81/0', 6: action }]); }
function setTimeUTC(ip, port, tz = 'UTC+0') {
  const ts = Math.floor(Date.now() / 1000);
  schoolingCommand(ip, port, [{ bn: '/3/0', 13: ts, 14: tz }]);
}
function setActiveAlarmReporting(ip, port, mode) { writeCommand(ip, port, [{ bn: '/80/0', 56: mode }]); }
function setBluetooth(ip, port, enable) { writeCommand(ip, port, [{ bn: '/80/0', 67: enable ? 1 : 0 }]); }
function queryNBInfo(ip, port) { writeCommand(ip, port, [{ bn: '/99/0', 20: 1 }]); }
function readFrozenDay(ip, port, yymmdd) { writeCommand(ip, port, [{ bn: '/80/0', 28: yymmdd }]); }
function readFrozenLatest(ip, port) { writeCommand(ip, port, [{ bn: '/80/0', 19: 0 }]); }
function queryMeterInfo(ip, port) { writeCommand(ip, port, [{ bn: '/80/0', 40: 1 }]); }

module.exports = {
  attachSocket,              // ← new
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
