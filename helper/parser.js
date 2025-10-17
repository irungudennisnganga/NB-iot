const cbor = require('cbor');
const { crc16 } = require('./crc16');
const { buildTimeCalibration,buildControlCommand  } = require('./meterCommands');

function parseUplink(hex, ip, port) {
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

  let meter_data = {};

  // Convert payload (array of maps) into a structured object
  let structured = {};
  for (const entry of payload) {
    const bn = entry.get('bn');
    if (!bn) continue;

    const obj = {};
    for (const [k, v] of entry.entries()) {
      if (k !== 'bn') obj[k] = v;
    }

    structured[bn] = obj;
  }

  // Now extract the data you want into `meter_data`
  for (const [bn, values] of Object.entries(structured)) {
    switch (bn) {
      case '/3/0':
        meter_data.meter_sn = values['2'];
        meter_data.time = values['13'];
        meter_data.time_zone = values['14'];

        if( values['20'] ===0 || values['20'] ==="0"){
          meter_data.battery_status = 'battery normal';
        }else if( values['20'] ===1 || values['20'] ==="1"){
          meter_data.battery_status = 'battery charging';
        }else if( values['20'] ===2 || values['20'] ==="2"){
          meter_data.battery_status = 'charging is finished, the battery is fully charged, it’s still charging';
        }else if( values['20'] ===3 || values['20'] ==="3"){
          meter_data.battery_status = 'battery is damaged';
        }else if( values['20'] ===4 || values['20'] ==="4"){
          meter_data.battery_status = 'low battery';
        }
        // meter_data.battery_status = values['20'];
        break;

      case '/80/0':
        meter_data.meter_reading = values['16'];
        meter_data.meter_error_status = values['6'];
        break;

      case '/84/0':
        meter_data.delivery_frequency = values['0'];
        break;

      case '/81/0':
        if (values['1'] ===1 || values['1'] ==="1") {
          meter_data.valve_status = 'closed';
        }else if (values['1'] ===0 || values['1'] ==="0"){
          meter_data.valve_status = 'open';
        }

        if (values['2'] ===1 || values['1'] ==="1") {
          meter_data.valve_faulty_status = 'faulty';
        }else if (values['2'] ===0 || values['2'] ==="0"){
          meter_data.valve_faulty_status = 'normal';
        }
        
        break;

      case '/99/0':
        meter_data.imei = values['1'];
        meter_data.signal_rssi = values['11'];
        meter_data.signal_snr = values['14'];
        break;

      default:
        break;
    }
  }


  
  
  // Extract SN if possible
  const sn =
    (Array.isArray(payload) && payload.find((e) => typeof e === 'object' && e[2]))?.[2] ||
    (Array.isArray(payload) && payload.find((e) => typeof e === 'object' && e[22]))?.[22] ||
    null;
    // buildTimeCalibration(meter_data.meter_sn, ip, port);
    buildControlCommand(meter_data.meter_sn, '/81/0', 0, 0, ip, port);
  return {
    header,
    crcOk: true,
    meter_data
  };
}

module.exports = { parseUplink };
