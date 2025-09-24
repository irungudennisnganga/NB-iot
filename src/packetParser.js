// Simulate parsing the packet. You will replace this with the manufacturer’s real protocol later.
export async function parsePacket(buffer) {
  const hex = buffer.toString('hex');

  return {
    crc: { ok: true },
    header: { type: hex.slice(0, 2) },
    payload: buffer.toString('utf8'),
    payloadHex: hex,
  };
}
