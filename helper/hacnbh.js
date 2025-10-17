// hacnbh.js
const cbor = require('cbor');
const dgram = require('dgram');
const { crc16 } = require('./crc16'); // MUST be CRC16/AUG-CCITT (init=0x1D0F, poly=0x1021)

// Helpers
function rand16() {
  const n = Math.floor(Math.random() * 0x10000);
  return [n >> 8, n & 0xff];
}
function u16(n) {
  return [ (n >> 8) & 0xff, n & 0xff ];
}

/**
 * Build a HAC-NBh packet.
 * @param {Array<object>} cborObjects - Array of CBOR objects (each with { bn: '/xx/x', <numericKey>: value, ... })
 * @param {number} funcCode - 0x03 (config write) or 0x45 (schooling)
 * @param {number} [msgType=0x00] - message type (0: needs confirm)
 * @param {number[]} [msgId] - optional 2-byte message id [hi, lo]; generated if omitted
 * @param {boolean} [encrypted=false] - false => 0xFF, true => 0xAA
 * @returns {Buffer} full packet (header + CBOR + CRC)
 */
function buildPacket(cborObjects, funcCode, msgType = 0x00, msgId, encrypted = false) {
  const payload = cbor.encode(cborObjects);
  const id = msgId || rand16();

  const header = Buffer.from([
    0x01, 0x01,            // Version 1.01
    msgType & 0xff,        // Message Type
    funcCode & 0xff,       // Function Code
    id[0], id[1],          // Message ID
    0x3c,                  // CBOR
    ...u16(payload.length),
    encrypted ? 0xaa : 0xff
  ]);

  const full = Buffer.concat([header, payload]);
  const crc = Buffer.from(u16(crc16(full)));
  return Buffer.concat([full, crc]);
}

/**
 * Send a packet via UDP.
 */
function sendUDP(packet, ip, port, label = 'Packet') {
  const sock = dgram.createSocket('udp4');
  sock.send(packet, port, ip, (err) => {
    if (err) {
      console.error(`❌ ${label} failed:`, err.message);
    } else {
      console.log(`✅ ${label} sent to ${ip}:${port}`);
      console.log('HEX:', packet.toString('hex'));
    }
    sock.close();
  });
}

/**
 * Write/config command (function code 0x03).
 * @param {string} ip
 * @param {number} port
 * @param {Array<object>} objects - e.g., [{ bn: '/81/0', 0: 1 }]  // close valve
 */
function writeCommand(ip, port, objects) {
  const pkt = buildPacket(objects, 0x03);
  sendUDP(pkt, ip, port, 'Config (WRITE)');
}

/**
 * Schooling command (function code 0x45), e.g., time calibration.
 * @param {string} ip
 * @param {number} port
 * @param {Array<object>} objects
 */
function schoolingCommand(ip, port, objects) {
  const pkt = buildPacket(objects, 0x45);
  sendUDP(pkt, ip, port, 'Schooling');
}

/* ---------------------------
 * READY-TO-USE COMMAND HELPERS
 * ---------------------------*/

/**
 * Open/Close valve
 * bn:/81/0, key 0 "Valve Control": 0=open, 1=close
 */
function valveOpen(ip, port) {
  writeCommand(ip, port, [{ bn: '/81/0', 0: 0 }]);
}
function valveClose(ip, port) {
  writeCommand(ip, port, [{ bn: '/81/0', 0: 1 }]);
}

/**
 * Force valve control (prepaid use)
 * bn:/81/0, key 6 "Force Valve Control": 0 open, 1 close, 2 cancel
 */
function valveForce(ip, port, action /* 0|1|2 */) {
  writeCommand(ip, port, [{ bn: '/81/0', 6: action }]);
}

/**
 * Time calibration (schooling)
 * bn:/3/0, key 13 "Current Time" (Unix), key 14 "UTC offset" (ISO 8601 string)
 */
function setTimeUTC(ip, port, tz = 'UTC+0') {
  const ts = Math.floor(Date.now() / 1000);
  schoolingCommand(ip, port, [{ bn: '/3/0', 13: ts, 14: tz }]);
}

/**
 * Enable active alarm report flag (bn:/80/0, key 56)
 * 0=off, 1=every alarm, 2=first of day only
 */
function setActiveAlarmReporting(ip, port, mode /* 0|1|2 */) {
  writeCommand(ip, port, [{ bn: '/80/0', 56: mode }]);
}

/**
 * Enable/disable Bluetooth (bn:/80/0, key 67)
 * 0=Disable, 1=Enable
 */
function setBluetooth(ip, port, enable /* 0|1 */) {
  writeCommand(ip, port, [{ bn: '/80/0', 67: enable ? 1 : 0 }]);
}

/**
 * Query NB module info (bn:/99/0, key 20 "Read NB information": 1)
 * (Reads are usually done by writing a "query" flag in that object)
 */
function queryNBInfo(ip, port) {
  writeCommand(ip, port, [{ bn: '/99/0', 20: 1 }]);
}

/**
 * Read frozen data for a day (bn:/80/0):
 * - Key 28: read a specific day (e.g., 240716 for 2024-07-16) or month (e.g., 2407)
 * - OR Key 19: read latest daily frozen (0), 1..8 previous months
 */
function readFrozenDay(ip, port, yymmdd /* e.g., 240716 */) {
  writeCommand(ip, port, [{ bn: '/80/0', 28: yymmdd }]);
}
function readFrozenLatest(ip, port) {
  writeCommand(ip, port, [{ bn: '/80/0', 19: 0 }]);
}

/**
 * Query meter information (bn:/80/0, key 40: 1)
 */
function queryMeterInfo(ip, port) {
  writeCommand(ip, port, [{ bn: '/80/0', 40: 1 }]);
}

module.exports = {
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
