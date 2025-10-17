// index.js
const dgram = require('dgram');
const { parseUplink } = require('../helper/parser');
const ctl = require('../helper/hacnbh'); // path to hacnbh.js

const socket = dgram.createSocket('udp4');
ctl.attachSocket(socket); // reuse THIS socket for all downlinks

// Optional: in-memory last-hop cache (by SN)
const lastHopBySN = new Map();

// Smarter SN extractor to match your parser shape
function extractSN(parsed) {
  return (
    // Your parser shape (as shown in the log)
    parsed?.meter_data?.meter_sn ??
    // Other common shapes / fallbacks
    parsed?.sn ??
    parsed?.SN ??
    parsed?.serial ??
    parsed?.serialNumber ??
    parsed?.deviceSN ??
    parsed?.device?.sn ??
    parsed?.dev?.sn ??
    // sometimes parsers attach /3/0 → 2 field as SN
    parsed?.['/3/0']?.[2] ??
    null
  );
}

socket.on('listening', () => {
  const addr = socket.address();
  console.log(`UDP server listening on ${addr.address}:${addr.port}`);
});

socket.on('error', (err) => {
  console.error('❌ UDP socket error:', err);
});

socket.on('message', async (msg, rinfo) => {
  console.log(`📨 UPLINK from ${rinfo.address}:${rinfo.port}`);

  try {
    // Safely detect ASCII-hex vs raw binary
    const asUtf8 = msg.toString('utf8');
    const looksAsciiHex =
      asUtf8.length >= 24 &&
      asUtf8.length % 2 === 0 &&
      /^[0-9a-fA-F]+$/.test(asUtf8);
    const hex = looksAsciiHex ? asUtf8 : msg.toString('hex');

    // Parse uplink (your parser already returns header + meter_data)
    const parsed = await parseUplink(hex, rinfo.address, rinfo.port);

    // Minimal, readable log
    const h = parsed?.header || {};
    console.log('parsed', parsed);
    console.log('✅ Parsed summary:', {
      bytes: hex.length / 2,
      from: `${rinfo.address}:${rinfo.port}`,
      msgType: h.msgType,
      functionCode: h.functionCode,
      msgId: h.msgId,
      crcOk: parsed?.crcOk,
    });

    // Learn last hop by SN
    const sn = extractSN(parsed);
    if (sn) {
      lastHopBySN.set(String(sn), {
        ip: rinfo.address,
        port: rinfo.port,
        seenAt: Date.now(),
      });
      console.log(`🔗 Route learned: SN=${sn} -> ${rinfo.address}:${rinfo.port}`);
    } else {
      console.warn('⚠️ SN not found; route not cached.');
    }

    // ---------------------------
    // EXAMPLES (uncomment to try)
    // ---------------------------

    // 1) Close valve (WRITE/config) back to same hop
    // ctl.valveClose(rinfo.address, rinfo.port, { mid: 0x1907e2 });

    // 2) Time calibration (SCHOOLING: msgType 0x02, func 0x45)
    // ctl.setTimeUTC(rinfo.address, rinfo.port, 'UTC+3', { mid: 0x18a2 });

    // 3) Query NB info
    // ctl.queryNBInfo(rinfo.address, rinfo.port, { mid: 0x0001 });

  } catch (e) {
    console.error('❌ Error parsing uplink:', e.message);
  }
});

// Bind your server port
socket.bind(10005);
