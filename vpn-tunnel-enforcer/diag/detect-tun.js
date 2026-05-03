const { networkInterfaces } = require('os');
const rx = /wintun|\btun\b|wireguard|\bwg\d*\b|openvpn|tap-windows|happ|hiddify|singbox|v2ray|xray/i;
for (const [n, a] of Object.entries(networkInterfaces())) {
  const hit = rx.test(n);
  const ipv4 = (a || []).filter(x => x.family === 'IPv4' && !x.internal).map(x => x.address).join(',');
  console.log((hit ? '[VPN?]' : '      ') + ' ' + n.padEnd(40) + ' ' + ipv4);
}
