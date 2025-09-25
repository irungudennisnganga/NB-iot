const dgram = require('dgram');

function sendUdpPacket() {
  const client = dgram.createSocket('udp4');

  // Your hex-encoded payload
  const hexString = '01010002cfbd3c00bcff86ab62626e642f332f3002693132333435363738390d1a64351eb70e655554432b3801634e426807190168110112655056332e30136c56332e30305f32313031303414001700a662626e652f38302f3000664c58432d323001020600101a0098967f151a64351eb7a462626e652f38312f30030101000201a362626e652f38322f3000000100a262626e652f38342f30001a00015180a562626e652f39392f30016f3836373732343033313736383430380b39040f0d39035b0e381fda50';

  const message = Buffer.from(hexString, 'hex');
  const port = 10005;
  const host = '127.0.0.1';

  client.send(message, port, host, (err) => {
    if (err) {
      console.error('❌ Error sending UDP packet:', err.message);
    } else {
      console.log(`✅ Packet sent to ${host}:${port}`);
    }
    client.close();
  });
}

sendUdpPacket();
