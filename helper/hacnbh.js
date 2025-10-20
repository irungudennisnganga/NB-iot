const cbor = require('cbor');
const dgram = require('dgram');
const { crc16 } = require('./crc16');

let sharedSocket = null; // attached from index.js

function attachSocket(sock) {
  sharedSocket = sock;
}

// ----------------- helpers -----------------
function rand16() {
  const n = Math.floor(Math.random() * 0x10000);
  return [n >> 8, n & 0xff];
}
function u16(n) {
  return [(n >> 8) & 0xff, n & 0xff];
}

/**
 * Keep numeric keys in CBOR by using a Map.
 * @param {string} bn - base name (/xx/x)
 * @param {Array<[number|string, any]>} entries - numeric keys like [[0,1],[56,2],...]
 */
function bnMap(bn, entries) {
  const m = new Map(entries); // numeric keys preserved
  m.set('bn', bn);            // 'bn' stays a text key
  return m;
}

/**
 * Build a HAC-NBh packet (header + CBOR + CRC).
 * @param {Array<object|Map>} cborObjects - array of maps/objects; prefer Map via bnMap()
 * @param {number} funcCode - 0x03 (config/write) or 0x45 (schooling)
 * @param {number} [msgType=0x00] - 0x00 for config, 0x02 for schooling (matches spec examples)
 * @param {number[]|undefined} msgId - optional [hi, lo]
 * @param {boolean} [encrypted=false] - false -> 0xFF, true -> 0xAA
 * @returns {Buffer}
 */
function buildPacket(cborObjects, funcCode, msgType = 0x00, msgId, encrypted = false) {
  const payload = cbor.encode(cborObjects);
  const id = msgId || rand16();

  const header = Buffer.from([
    0x01, 0x01,                 // Version 1.01
    msgType & 0xff,             // Message Type
    funcCode & 0xff,            // Function Code
    id[0], id[1],               // Message ID (2 bytes)
    0x3c,                       // Payload: CBOR
    ...u16(payload.length),     // Data length
    encrypted ? 0xaa : 0xff     // Separator (FF no-encrypt, AA AES)
  ]);

  const full = Buffer.concat([header, payload]);
  const crc = Buffer.from(u16(crc16(full))); // AUG-CCITT over header+CBOR
  return Buffer.concat([full, crc]);
}

/** Send via UDP, reusing the shared socket if attached. */
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

  // Fallback: ephemeral socket only if no shared socket
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

// --------------- command builders ---------------

/**
 * Generic WRITE/config command (func=0x03).
 * Automatically appends /70/0,2:<mid> if opts.mid is provided to match sample frames.
 * @param {string} ip
 * @param {number} port
 * @param {Array<Map|object>} objects
 * @param {Object} [opts]
 * @param {number} [opts.mid]  - appended as /70/0 key 2
 * @param {number[]} [opts.msgId] - message id [hi, lo]
 */
function writeCommand(ip, port, objects, opts = {}) {
  const { mid, msgId } = opts;
  const payload = mid != null ? [...objects, bnMap('/70/0', [[2, mid]])] : objects;
  const pkt = buildPacket(payload, 0x03, 0x00, msgId);
  sendUDP(pkt, ip, port, 'Config (WRITE)');
}

/**
 * Schooling command (func=0x45). Spec examples use msgType=0x02.
 * @param {string} ip
 * @param {number} port
 * @param {Array<Map|object>} objects
 * @param {Object} [opts]
 * @param {number} [opts.mid]
 * @param {number[]} [opts.msgId]
 */
function schoolingCommand(ip, port, objects, opts = {}) {
  const { mid, msgId } = opts;
  const payload = mid != null ? [...objects, bnMap('/70/0', [[2, mid]])] : objects;
  const pkt = buildPacket(payload, 0x45, 0x02, msgId);
  sendUDP(pkt, ip, port, 'Schooling');
}

// --------------- high-level helpers ---------------

// Valve control: bn:/81/0, key 0 → 0=open, 1=close
function valveOpen(ip, port, opts) {
  writeCommand(ip, port, [bnMap('/81/0', [[0, 0]])]);
}
function valveClose(ip, port, opts) {
  // writeCommand(ip, port, [bnMap('/81/0', [[0, 1]])]);
  writeCommand(ip, port, [ bnMap('/81/0', [[3, 1]]) ]);
}

// Force valve (prepaid): bn:/81/0, key 6 → 0 open, 1 close, 2 cancel
function valveForce(ip, port, action /* 0|1|2 */, opts) {
  writeCommand(ip, port, [bnMap('/81/0', [[6, action]])], opts);
}

// Time calibration (schooling): bn:/3/0, keys 13 (Unix time), 14 (UTC offset string)
function setTimeUTC(ip, port, tz = 'UTC+0', opts) {
  const ts = Math.floor(Date.now() / 1000);
  schoolingCommand(ip, port, [bnMap('/3/0', [[13, ts], [14, tz]])], opts);
}

// Enable active alarm reporting: bn:/80/0, key 56 → 0 off, 1 every, 2 first-of-day
function setActiveAlarmReporting(ip, port, mode /* 0|1|2 */, opts) {
  writeCommand(ip, port, [bnMap('/80/0', [[56, mode]])], opts);
}

// Bluetooth toggle: bn:/80/0, key 67 → 0 disable, 1 enable
function setBluetooth(ip, port, enable, opts) {
  writeCommand(ip, port, [bnMap('/80/0', [[67, enable ? 1 : 0]])], opts);
}

// Query NB info: bn:/99/0, key 20 → 1
function queryNBInfo(ip, port, opts) {
  writeCommand(ip, port, [bnMap('/99/0', [[20, 1]])], opts);
}

// Read frozen data: bn:/80/0, key 28 (YYMMDD or YYMM), or key 19 (0 latest)
function readFrozenDay(ip, port, yymmdd, opts) {
  writeCommand(ip, port, [bnMap('/80/0', [[28, yymmdd]])], opts);
}
function readFrozenLatest(ip, port, opts) {
  writeCommand(ip, port, [bnMap('/80/0', [[19, 0]])], opts);
}

// Query meter info: bn:/80/0, key 40 → 1
function queryMeterInfo(ip, port, opts) {
  writeCommand(ip, port, [bnMap('/80/0', [[40, 1]])], opts);
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
