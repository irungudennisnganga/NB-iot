const cbor = require('cbor');
const dgram = require('dgram');
const { crc16 } = require('./crc16');

// Helper: random 16-bit integer → [high, low]
function random16bit() {
  const n = Math.floor(Math.random() * 65535);
  return [n >> 8, n & 0xff];
}

// Helper: convert number to 16-bit array
function to16bit(n) {
  return [n >> 8, n & 0xff];
}

/**
 * 🕓 Build + Send Time Calibration Command
 * @param {string} sn - Serial number of meter
 * @param {string} ip - Target meter IP address
 * @param {number} port - Target meter UDP port
 */
function buildTimeCalibration(sn, ip, port) {
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
    0xff               // Delimiter
  ]);

  const full = Buffer.concat([header, cborBuf]);
  const crc = to16bit(crc16(full));
  const packet = Buffer.concat([full, Buffer.from(crc)]);

  sendUDP(packet, ip, port, 'Time Calibration');
}

/**
 * ⚙️ Build + Send Control Command
 * @param {string} sn - Serial number of meter
 * @param {string} bn - Base name (e.g., '/81/0')
 * @param {number|string} key - Key (attribute code)
 * @param {any} value - Value to send
 * @param {string} ip - Target meter IP address
 * @param {number} port - Target meter UDP port
 */
function buildControlCommand(sn, bn, key, value, ip, port, operation = 'W') {
  const data = [
    {
      op: operation,   // Add operation type (R, W, or E)
      bn,              // Base name (object)
      [key]: value,    // The actual data to write
      22: sn           // Serial number
    },
    { 2: 2018, bn: '/70/0' }  // metadata section
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
  const packet = Buffer.concat([full, Buffer.from(crc)]);

  sendUDP(packet, ip, port, `Control Command (${operation})`);
}


/**
 * 📡 Send UDP Packet to Target Meter
 */
function sendUDP(packet, ip, port, label = 'Packet') {
  const client = dgram.createSocket('udp4');

  client.send(packet, port, ip, (err) => {
    if (err) {
      console.error(`❌ Failed to send ${label}:`, err.message);
    } else {
      console.log(`✅ ${label} sent to ${ip}:${port}`);
      console.log('Hex Data:', packet.toString('hex'));
    }
    client.close();
  });
}

module.exports = { buildTimeCalibration, buildControlCommand };
