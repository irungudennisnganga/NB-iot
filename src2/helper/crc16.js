// Polynomial: 0x1021, Init: 0x1D0F
function crc16(buffer) {
  let crc = 0x1d0f;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i] << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc <<= 1;
      }
      crc &= 0xffff;
    }
  }
  return crc;
}

module.exports = { crc16 };
