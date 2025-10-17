const cbor = require('cbor');
const { crc16 } = require('./crc16');
const { hexPad } = require('./utils');

function buildTimeCalibration(sn) {
  const timestamp = Math.floor(Date.now() / 1000);

  const data = [{
    2: sn,
    13: timestamp,
    14: 'UTC+3',
    bn: '/3/0',
  }];

  const cborBuf = cbor.encode(data);
  const header = Buffer.from([
    0x01, 0x01,        // Version
    0x02,              // Msg Type: Time Calibration
    0x45,              // Function code
    ...random16bit(),  // Msg ID
    0x3c,              // Format: CBOR
    ...to16bit(cborBuf.length),
    0xff,              // Delimiter
  ]);

  const full = Buffer.concat([header, cborBuf]);
  const crc = to16bit(crc16(full));
  return Buffer.concat([full, Buffer.from(crc)]).toString('hex');
}

function buildControlCommand(sn, bn, key, value) {
  const data = [
    { [key]: value, 22: sn, bn },
    { 2: 2018, bn: '/70/0' }
  ];
  const cborBuf = cbor.encode(data);
  const header = Buffer.from([
    0x01, 0x01,        // Version
    0x00,              // Msg Type
    0x03,              // Function code
    ...random16bit(),  // Msg ID
    0x3c,              // Format: CBOR
    ...to16bit(cborBuf.length),
    0xff               // Delimiter
  ]);

  const full = Buffer.concat([header, cborBuf]);
  const crc = to16bit(crc16(full));
  return Buffer.concat([full, Buffer.from(crc)]).toString('hex');
}

function random16bit() {
  const n = Math.floor(Math.random() * 65535);
  return [n >> 8, n & 0xff];
}

function to16bit(n) {
  return [n >> 8, n & 0xff];
}

module.exports = { buildTimeCalibration, buildControlCommand };
