// helper/hacnbh.js
const cbor = require('cbor');
const dgram = require('dgram');
const { crc16 } = require('./crc16');

let sharedSocket = null;

function attachSocket(sock) { sharedSocket = sock; }

// utils
function rand16Pair() { const n = Math.floor(Math.random()*0x10000); return [ (n>>8)&0xff, n&0xff ]; }
function u16(n) { return [ (n>>8)&0xff, n&0xff ]; }
function toIdArr(id) { if (id==null) return undefined; return Array.isArray(id) ? id : [ (id>>8)&0xff, id&0xff ]; }

// CBOR bn helper — keeps numeric keys as numbers
function bnMap(bn, entries) { const m = new Map(entries); m.set('bn', bn); return m; }

// frame builder
function buildPacket(cborObjects, funcCode, msgType=0x00, msgId, encrypted=false) {
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

function sendUDP(packet, ip, port, label='Packet') {
  if (sharedSocket) {
    sharedSocket.send(packet, port, ip, (err) => {
      if (err) console.error(`❌ ${label} failed:`, err.message);
      else {
        console.log(`✅ ${label} sent to ${ip}:${port}`);
        console.log('HEX:', packet.toString('hex'));
      }
    });
    return;
  }
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

// WRITE/config (0x03)
function writeCommand(ip, port, objects, opts={}) {
  const { mid, msgId, encrypted } = opts;
  const idArr = toIdArr(msgId);
  const payload = mid!=null ? [...objects, bnMap('/70/0', [[2, mid]])] : objects;
  const pkt = buildPacket(payload, 0x03, 0x00, idArr, !!encrypted);
  sendUDP(pkt, ip, port, 'Config (WRITE)');
}

// SCHOOLING (0x45, msgType=0x02)
function schoolingCommand(ip, port, objects, opts={}) {
  const { mid, msgId, encrypted } = opts;
  const idArr = toIdArr(msgId);
  const payload = mid!=null ? [...objects, bnMap('/70/0', [[2, mid]])] : objects;
  const pkt = buildPacket(payload, 0x45, 0x02, idArr, !!encrypted);
  sendUDP(pkt, ip, port, 'Schooling');
}

// High-level
function valveOpen(ip, port,opts) { writeCommand(ip, port, [bnMap('/81/0', [[0, 0]])],opts); }
function valveClose(ip, port,opts) { writeCommand(ip, port, [bnMap('/81/0', [[0, 1]])],opts); }
function valveForce(ip, port, action /*0|1|2*/, opts={}) { writeCommand(ip, port, [bnMap('/81/0', [[6, action]])], opts); }

// Choose normal (key 0) or force (key 6) based on opts.useForce
function valveSend(ip, port, desired /* 'open'|'close' */, opts={}) {
  if (opts.useForce) {
    const action = desired === 'open' ? 0 : 1;
    return valveForce(ip, port, action);
  }
  return desired === 'open'
    ? valveOpen(ip, port)
    : valveClose(ip, port);
}

function setTimeUTC(ip, port, tz='UTC+0', opts={}) {
  const ts = Math.floor(Date.now()/1000);
  schoolingCommand(ip, port, [bnMap('/3/0', [[13, ts], [14, tz]])], opts);
}
function setActiveAlarmReporting(ip, port, mode /*0|1|2*/, opts={}) {
  writeCommand(ip, port, [bnMap('/80/0', [[56, mode]])], opts);
}
function setBluetooth(ip, port, enable, opts={}) {
  writeCommand(ip, port, [bnMap('/80/0', [[67, enable?1:0]])], opts);
}
function queryNBInfo(ip, port, opts={}) {
  writeCommand(ip, port, [bnMap('/99/0', [[20, 1]])], opts);
}
function readFrozenDay(ip, port, yymmdd, opts={}) {
  writeCommand(ip, port, [bnMap('/80/0', [[28, yymmdd]])], opts);
}
function readFrozenLatest(ip, port, opts={}) {
  writeCommand(ip, port, [bnMap('/80/0', [[19, 0]])], opts);
}
function queryMeterInfo(ip, port, opts={}) {
  writeCommand(ip, port, [bnMap('/80/0', [[40, 1]])], opts);
}

module.exports = {
  attachSocket,
  bnMap,
  buildPacket,
  writeCommand,
  schoolingCommand,
  // single entry that picks normal/force:
  valveSend,
  // also export these explicitly if you want:
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
