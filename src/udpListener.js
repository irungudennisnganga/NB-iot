import dgram from 'dgram';
import { log, warn, err } from './logger.js';
import { parsePacket } from './packetParser.js';
import dotenv from 'dotenv';
dotenv.config();

const config = {
  port: parseInt(process.env.UDP_PORT) || 5040,
  host: process.env.UDP_HOST || '0.0.0.0',
  heartbeat: {
    enabled: process.env.HEARTBEAT_ENABLED === 'true',
    intervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS) || 30000,
  },
};

export function startUdpListener() {
  const socket = dgram.createSocket('udp4');

  socket.on('error', (e) => {
    err('UDP error:', e);
    socket.close();
  });

  // Main receive handler
  socket.on('message', async (msg, rinfo) => {
    log(`UDP pkt ${msg.length}B from ${rinfo.address}:${rinfo.port}`);
    log('RAW HEX:', msg.toString('hex'));
    log('RAW ASCII:', msg.toString('utf8'));

    if (msg.length >= 12) {
      try {
        const parsed = await parsePacket(msg);
        if (!parsed.crc.ok) warn('CRC mismatch:', parsed.crc);

        log('Header:', parsed.header);

        if (parsed.payload) {
          log('Payload (decoded):', parsed.payload);

          // 👇 Simulate response
          const response = Buffer.from('0102030405', 'hex');
          socket.send(response, rinfo.port, rinfo.address, (e) => {
            if (e) err('Reply failed:', e.message);
            else log(`Replied to ${rinfo.address}:${rinfo.port}`);
          });

        } else {
          log('Payload (hex):', parsed.payloadHex);
        }
      } catch (e) {
        err('Parse failed:', e.message);
      }
    } else {
      warn('Too short for protocol parsing; logged raw only.');
    }
  });

  socket.on('listening', () => {
    const addr = socket.address();
    log(`UDP listening on ${addr.address}:${addr.port}`);
  });

  socket.bind(config.port, config.host);

  // Optional heartbeat every X seconds
  if (config.heartbeat.enabled) {
    const hb = () => {
      const payload = Buffer.from('68656c6c6f', 'hex'); // "hello" in hex
      // NOTE: No known target, just log
      log('Heartbeat:', payload.toString('utf8'));
    };
    setInterval(hb, config.heartbeat.intervalMs);
    log(`Heartbeat enabled every ${config.heartbeat.intervalMs}ms`);
  }

  return socket;
}
