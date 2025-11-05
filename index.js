const dgram = require('dgram');
const { parseUplink } = require('./helper/parser');

const socket = dgram.createSocket('udp4');

socket.on('listening', () => {
  const addr = socket.address();
  console.log(`UDP server listening on ${addr.address}:${addr.port}`);
});

socket.on('message', async (msg, rinfo) => {
  console.log(`UPLINK from ${rinfo.address}:${rinfo.port}`);

  try {
    // Robust ASCII-hex detection:
    // - decode to utf8
    // - only hex chars
    // - even length
    // - long enough to plausibly be a frame (>=24 nibbles)
    const asUtf8 = msg.toString('utf8');
    const isAsciiHex =
      /^[0-9a-fA-F]+$/.test(asUtf8) &&
      asUtf8.length % 2 === 0 &&
      asUtf8.length >= 24;

    const hex = isAsciiHex ? asUtf8 : msg.toString('hex');

    // Pass IP and port that parseUplink expects
    const result = await parseUplink(hex, rinfo.address, rinfo.port);

    console.log('✅ Parsed:', result);
  } catch (e) {
    console.error('❌ Error parsing uplink:', e?.message || e);
  }
});

socket.bind(10005);
