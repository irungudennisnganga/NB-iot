const cbor = require('cbor');
const { crc16 } = require('./crc16');

function parseUplink(hex) {
  const buf = Buffer.from(hex, 'hex');
  console.log('buf',buf)

  if (buf.length < 12) {
    throw new Error('Too short to be a valid packet');
  }

  const header = {
    version: buf.slice(0, 2).toString('hex'),
    msgType: buf[2],
    functionCode: buf[3],
    msgId: buf.slice(4, 6).toString('hex'),
    format: buf[6],
    dataLen: buf.readUInt16BE(7)
  };

  let payloadStart;
  let payloadEnd;
  const expectedLen = header.dataLen;

  // Try to locate 0xFF delimiter
  const delimiterIndex = buf.indexOf(0xFF, 9);
  if (delimiterIndex !== -1) {
    payloadStart = delimiterIndex + 1;
  } else {
    // Fallback: assume payload starts immediately after byte 9
    payloadStart = 10;
  }

  payloadEnd = payloadStart + expectedLen;

  if (buf.length < payloadEnd + 2) {
    throw new Error(`Buffer too short for expected payload length=${expectedLen}`);
  }

  const dataField = buf.slice(payloadStart, payloadEnd);
  const crcReceived = buf.slice(payloadEnd, payloadEnd + 2).readUInt16BE();
  const crcCalc = crc16(buf.slice(0, payloadEnd));

  if (crcReceived !== crcCalc) {
    throw new Error(`CRC mismatch. Expected ${crcCalc.toString(16)}, got ${crcReceived.toString(16)}`);
  }

  let cborData;
  try {
    cborData = cbor.decodeAllSync(dataField);
  } catch (e) {
    throw new Error(`CBOR decoding failed: ${e.message}`);
  }

  const payload = cborData[0];
  console.log('payload',payload)

  // Extract SN if possible
  const sn =
    (Array.isArray(payload) && payload.find((e) => typeof e === 'object' && e[2]))?.[2] ||
    (Array.isArray(payload) && payload.find((e) => typeof e === 'object' && e[22]))?.[22] ||
    null;

  return {
    header,
    crcOk: true,
    sn,
    payload
  };
}

module.exports = { parseUplink };
