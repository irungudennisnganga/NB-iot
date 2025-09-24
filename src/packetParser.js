import * as cbor from 'cbor';
import { crc16ccitt } from 'crc'; // Comes from 'crc' package

export async function parsePacket(buffer) {
  const bver = buffer.slice(0, 2).toString('hex'); // Protocol version
  const msgType = buffer[2];
  const code = buffer[3];
  const msgId = buffer.readUInt16BE(4);
  const payloadFormat = buffer[6];
  const dataLen = buffer.readUInt16BE(7);
  const separator = buffer[9];

  const payloadStart = 10;
  const payloadEnd = 10 + dataLen;

  const payloadBuffer = buffer.slice(payloadStart, payloadEnd);
  const crcRaw = buffer.slice(payloadEnd, payloadEnd + 2); // 2-byte CRC
  const crcExpected = crcRaw.readUInt16BE();

  // Slice all up to (but not including) CRC for calculation
  const dataToCheck = buffer.slice(0, payloadEnd);
  const crcCalculated = crc16ccitt(dataToCheck);

  let cborPayload = null;
  let cborJson = null;

  try {
    cborPayload = await cbor.decodeAll(payloadBuffer);
    cborJson = JSON.stringify(cborPayload, null, 2);
  } catch (e) {
    throw new Error('CBOR decoding failed: ' + e.message);
  }

  return {
    header: {
      version: bver,
      messageType: msgType,
      functionCode: code,
      messageId: msgId,
      payloadFormat,
      dataLength: dataLen,
      separator,
    },
    payload: cborPayload,
    payloadJson: cborJson,
    crc: {
      expected: '0x' + crcExpected.toString(16),
      calculated: '0x' + crcCalculated.toString(16),
      ok: crcExpected === crcCalculated,
    },
  };
}
