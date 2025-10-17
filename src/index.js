const dgram = require('dgram');
const { parseUplink } = require('../helper/parser');

const socket = dgram.createSocket('udp4');

socket.on('listening', () => {
  const addr = socket.address();
  console.log(`UDP server listening on ${addr.address}:${addr.port}`);
});

socket.on('message', (msg, rinfo) => {
  console.log(`UPLINK from ${rinfo.address}:${rinfo.port}`);

  try {
    // STEP 1: Check if msg is ASCII-encoded hex string
    const isAsciiHex = /^[0-9a-fA-F]+$/.test(msg.toString('utf8')) && msg.length > 20;

    const hex = isAsciiHex ? msg.toString('utf8') : msg.toString('hex');
    const result = parseUplink(hex,rinfo.address,rinfo.port);

    console.log('✅ Parsed:', result);
  } catch (e) {
    console.error('❌ Error parsing uplink:', e.message);
  }
});

socket.bind(10005); // or whatever port
