const cbor = require('cbor');
const dgram = require('dgram');
const { crc16 } = require('./crc16');

// Helper: random 16-bit integer → [high, low] (big-endian)
function random16bit() {
  const id = Math.floor(Math.random() * 0x10000); // 0–65535
  return [(id >> 8) & 0xff, id & 0xff];
}

// Helper: convert number to 16-bit [high, low] (big-endian)
function to16bit(n) {
  return [(n >> 8) & 0xff, n & 0xff];
}

/**
 * ⚙️ Build + Send Control Command (Platform → Meter)
 * @param {string|number} sn - Serial number of meter (you can add into CBOR if needed)
 * @param {string} bn - Base name (e.g., '/81/0')
 * @param {number|string} key - Resource key (attribute code)
 * @param {any} value - Value to write/read/execute
 * @param {string} ip - Target meter IP address
 * @param {number} port - Target meter UDP port
 * @param {string} operation - 'R', 'W', or 'E'
 */
function buildControlCommand(sn, bn, key, value, ip, port, operation = 'W') {
  try {
    // 🔹 Data field (CBOR payload) – adjust to match your vendor's examples
    const data = [
      {
        op: operation,    // 'R' | 'W' | 'E'
        bn,               // base name (object path, e.g. '/81/0')
        [key]: value      // e.g. { 16: 123456 }
        // You can also add SN here if their spec uses it in the CBOR map
      },
      { 2: 2018, bn: '/70/0' } // metadata/version example, keep if required by doc
    ];

    // 1️⃣ Encode payload to CBOR
    const cborBuf = cbor.encode(data);

    // 2️⃣ Build header (fixed part, before separator)
    const header = Buffer.from([
      0x01, 0x01,              // Version number: 01 01 (V1.01)
      0x00,                    // Message type: 0 (needs confirmation)
      0x03,                    // Function code: 0x03 (platform sends config command)
      ...random16bit(),        // Message ID (random 16-bit, big-endian)
      0x3c,                    // Data field format: 0x3C (CBOR)
      ...to16bit(cborBuf.length) // Data field length (n bytes of CBOR)
    ]);

    // 3️⃣ Separator: encryption flag
    const separator = Buffer.from([
      0xff                     // 0xFF = not encrypted (AA would mean AES256)
    ]);

    // 4️⃣ Concatenate header + separator + CBOR data (this is the part covered by CRC)
    const noCrc = Buffer.concat([header, separator, cborBuf]);

    // 5️⃣ Compute CRC16/AUG-CCITT over **all data above**
    const crcVal = crc16(noCrc);
    const crcBuf = Buffer.from(to16bit(crcVal)); // 2-byte big-endian checksum

    // 6️⃣ Final packet: [ header | separator | data | CRC ]
    const packet = Buffer.concat([noCrc, crcBuf]);
    console.log('🔧 Built Control Command Packet:', packet);
    // 7️⃣ Send via UDP
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
