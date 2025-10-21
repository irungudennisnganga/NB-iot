// udpSocket.js
const dgram = require('dgram');
const { parseUplink } = require('./helper/parser');
const ctl = require('./helper/hacnbh');

const socket = dgram.createSocket('udp4');
ctl.attachSocket(socket); // allow ctl to send using this socket

const lastHopBySN = new Map();

function extractSN(parsed) {
  return (
    parsed?.meter_data?.meter_sn ?? parsed?.sn ?? parsed?.SN ??
    parsed?.serial ?? parsed?.serialNumber ?? parsed?.deviceSN ??
    parsed?.device?.sn ?? parsed?.dev?.sn ?? parsed?.['/3/0']?.[2] ?? null
  );
}

// Socket listeners
socket.on('listening', () => {
  const addr = socket.address();
  console.log(`📡 UDP listening on ${addr.address}:${addr.port}`);
});

socket.on('error', (err) => {
  console.error('❌ UDP socket error:', err);
});

socket.on('message', async (msg, rinfo) => {
  console.log(`📨 UPLINK from ${rinfo.address}:${rinfo.port}`);

  try {
    const utf8 = msg.toString('utf8');
    const asciiHex = (utf8.length >= 24 && utf8.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(utf8));
    const hex = asciiHex ? utf8 : msg.toString('hex');
    const parsed = await parseUplink(hex, rinfo.address, rinfo.port);

    const h = parsed?.header || {};
    console.log('✅ Parsed summary:', {
      bytes: hex.length / 2,
      from: `${rinfo.address}:${rinfo.port}`,
      msgType: h.msgType,
      functionCode: h.functionCode,
      msgId: h.msgId,
      crcOk: parsed?.crcOk,
      parsed,
    });

    const sn = extractSN(parsed);
    if (sn) {
      lastHopBySN.set(String(sn), { ip: rinfo.address, port: rinfo.port, seenAt: Date.now() });
      console.log(`🔗 Route learned: SN=${sn} -> ${rinfo.address}:${rinfo.port}`);
    } else {
      console.warn('⚠️ SN not found; route not cached.');
    }
  } catch (err) {
    console.error('❌ Error parsing uplink:', err.message);
  }
});

// Bind to port 10005 by default
function bindUDP(port = 10005) {
  socket.bind(port);
}

module.exports = {
  socket,
  bindUDP,
  lastHopBySN,
};
