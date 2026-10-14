// Shared by phone.js (sender) and phone-link.js (game tab). Plain script, no modules, so both pages
// can load it with a <script> tag.
//
// One binary packet per phone sensor event, 44 bytes, little-endian:
//   u8  version (1)   u8 reserved   u16 sequence
//   u32 buttons (Wii Remote bits, runtime/include/web_phone.h)   u32 flags (kFlag* bits)
//   f64 phone sensor time in ms
//   f32 gyro x, y, z      rad/s, SDL axes (+X right, +Y top of phone, +Z out of the screen)
//   f32 accel x, y, z     m/s^2 support force (+9.81 on the axis pointing up when still)
// Signaling and status messages are JSON text: {t: 'offer'|'answer'|'ice'|'peer'|'hello', ...}.
(function (root) {
  const PACKET_BYTES = 44;
  const BUTTONS = {
    Left: 0x0001, Right: 0x0002, Down: 0x0004, Up: 0x0008, Plus: 0x0010,
    2: 0x0100, 1: 0x0200, B: 0x0400, A: 0x0800, Minus: 0x1000, Home: 0x8000,
  };
  const FLAGS = { Recenter: 0x1, Shake: 0x2 };

  function encode(seq, buttons, flags, timeMs, g, a) {
    const buf = new ArrayBuffer(PACKET_BYTES);
    const v = new DataView(buf);
    v.setUint8(0, 1); v.setUint16(2, seq & 0xFFFF, true);
    v.setUint32(4, buttons >>> 0, true); v.setUint32(8, flags >>> 0, true);
    v.setFloat64(12, timeMs, true);
    for (let i = 0; i < 3; i++) { v.setFloat32(20 + 4 * i, g[i], true); v.setFloat32(32 + 4 * i, a[i], true); }
    return buf;
  }

  function decode(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength !== PACKET_BYTES) return null;
    const v = new DataView(buf);
    if (v.getUint8(0) !== 1) return null;
    const f = (o) => v.getFloat32(o, true);
    return {
      seq: v.getUint16(2, true), buttons: v.getUint32(4, true), flags: v.getUint32(8, true),
      timeMs: v.getFloat64(12, true), gyro: [f(20), f(24), f(28)], acc: [f(32), f(36), f(40)],
    };
  }

  function signalUrl(room, role) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/signal/${encodeURIComponent(room)}?role=${role}`;
  }

  const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  // No ambiguous letters or digits (0/O, 1/I/L).
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  root.WsrPhoneProtocol = { PACKET_BYTES, BUTTONS, FLAGS, encode, decode, signalUrl, ICE_SERVERS, CODE_ALPHABET };
})(typeof window !== 'undefined' ? window : globalThis);
