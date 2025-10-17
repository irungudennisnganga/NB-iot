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
 * ⚙️ Build + Send Control Command
 * @param {string|number} sn - Serial number of meter
 * @param {string} bn - Base name (e.g., '/81/0')
 * @param {number|string} key - Resource key (attribute code)
 * @param {any} value - Value to write/read/execute
 * @param {string} ip - Target meter IP address
 * @param {number} port - Target meter UDP port
 * @param {string} operation - 'R', 'W', or 'E'
 */
function buildControlCommand(sn, bn, key, value, ip, port, operation = 'W') {
  try {
    const data = [
      {
        op: operation,    // R = Read, W = Write, E = Execute
        bn,               // Base name (object path)
        [key]: value,     // Key-value pair to send
                 // Serial number (attribute code 22)
      },
      { 2: 2018, bn: '/70/0' } // Metadata / version info
    ];

    // Encode payload to CBOR
    const cborBuf = cbor.encode(data);

    // Construct protocol header
    const header = Buffer.from([
      0x01, 0x01,              // Version number: 1.01
      0x00,                    // Message Type: confirmation required
      0x02,                    // Message Code: write/update resource
      ...random16bit(),        // Message ID (random 16-bit)
      0x3c,                    // Format: CBOR
      ...to16bit(cborBuf.length),
      0xff                     // Separator: not encrypted
    ]);

    // Combine header + CBOR payload
    const full = Buffer.concat([header, cborBuf]);

    // Compute CRC16 (AUG-CCITT)
    const crcVal = crc16(full);
    const crcBuf = Buffer.from(to16bit(crcVal));

    // Final packet
    const packet = Buffer.concat([full, crcBuf]);

    // Send via UDP
    sendUDP(packet, ip, port, `Control Command (${operation})`);

  } catch (error) {
    console.error('❌ Error building control command:', error.message);
  }
}

/**
 * 🕓 Build + Send Time Calibration Command
 */
function buildTimeCalibration(sn, ip, port) {
  const timestamp = Math.floor(Date.now() / 1000);

  const data = [{
    2: sn,
    13: timestamp,
    14: 'UTC+3',
    bn: '/3/0'
  }];

  const cborBuf = cbor.encode(data);

  const header = Buffer.from([
    0x01, 0x01,        // Version
    0x02,              // Msg Type
    0x45,              // Function code
    ...random16bit(),  // Msg ID
    0x3c,              // Format: CBOR
    ...to16bit(cborBuf.length),
    0xff               // Delimiter
  ]);

  const full = Buffer.concat([header, cborBuf]);
  const crcBuf = Buffer.from(to16bit(crc16(full)));
  const packet = Buffer.concat([full, crcBuf]);

  sendUDP(packet, ip, port, 'Time Calibration');
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
      console.log('🔹 Hex Data:', packet.toString('hex'));
    }
    client.close();
  });
}

module.exports = { buildControlCommand, buildTimeCalibration };
