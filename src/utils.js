function hexPad(n, length = 4) {
  return n.toString(16).padStart(length, '0');
}

module.exports = { hexPad };
