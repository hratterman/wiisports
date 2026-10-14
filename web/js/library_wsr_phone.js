// Phone-as-Wii-Remote glue for the WebAssembly build, linked with --js-library.
// C++ side: runtime/src/platform/web/web_phone.cpp (runtime/include/web_phone.h).
//
// The page's phone link (web/site/phone-link.js) calls these; the runtime drains the ring from the
// virtual Wii Remote on its own schedule, so nothing here ever calls into wasm.
//   Module.wsrPhone.ready()                         -> true once the runtime attached the ring
//   Module.wsrPhone.setConnected(bool)              phone linked / gone (bumps the generation on link)
//   Module.wsrPhone.setControls(buttons, flags, stickX, stickY)
//                                                   Wii Remote + Nunchuk button bits, kFlag* bits
//                                                   (web_phone.h), Nunchuk stick -1..1 (up positive)
//   Module.wsrPhone.push(timeMs, gx,gy,gz, ax,ay,az) one sensor report, SDL axes, rad/s and m/s^2
// Module callback (optional): Module.onWsrPhoneReady() once the ring exists.

addToLibrary({
  $WsrPhone__postset: 'WsrPhone.install();',
  $WsrPhone: {
    state: 0,
    reports: 0,
    ring: 0,

    install() {
      Module['wsrPhone'] = {
        'ready': () => WsrPhone.state !== 0,
        'setConnected': (on) => WsrPhone.setConnected(on),
        'setControls': (buttons, flags, sx, sy) => WsrPhone.setControls(buttons, flags, sx, sy),
        'push': (t, gx, gy, gz, ax, ay, az) => WsrPhone.push(t, gx, gy, gz, ax, ay, az),
      };
    },

    // Layout: web_phone.h detail::State.
    u32(offset) { return (WsrPhone.state + offset) >> 2; },

    setConnected(on) {
      if (!WsrPhone.state) return false;
      const was = HEAPU32[WsrPhone.u32(4)] !== 0;
      if (on && !was) HEAPU32[WsrPhone.u32(8)] = (HEAPU32[WsrPhone.u32(8)] + 1) >>> 0;
      HEAPU32[WsrPhone.u32(4)] = on ? 1 : 0;
      if (!on) { HEAPU32[WsrPhone.u32(12)] = 0; HEAPU32[WsrPhone.u32(16)] = 0; }
      return true;
    },

    setControls(buttons, flags, sx, sy) {
      if (!WsrPhone.state) return false;
      const axis = (v) => Math.max(-1000, Math.min(1000, Math.round((Number(v) || 0) * 1000)));
      HEAPU32[WsrPhone.u32(12)] = buttons >>> 0;
      HEAPU32[WsrPhone.u32(16)] = flags >>> 0;
      HEAP16[(WsrPhone.state + 28) >> 1] = axis(sx);
      HEAP16[(WsrPhone.state + 30) >> 1] = axis(sy);
      return true;
    },

    // Report: u64 timeNs, f32 gyro[3], f32 acc[3], u32 pad (40 bytes).
    push(timeMs, gx, gy, gz, ax, ay, az) {
      if (!WsrPhone.state) return false;
      const write = HEAPU32[WsrPhone.u32(20)];
      const p = WsrPhone.reports + (write % WsrPhone.ring) * 40;
      HEAPU64[p >> 3] = BigInt(Math.max(0, Math.round(timeMs * 1e6)));
      HEAPF32[(p + 8) >> 2] = gx; HEAPF32[(p + 12) >> 2] = gy; HEAPF32[(p + 16) >> 2] = gz;
      HEAPF32[(p + 20) >> 2] = ax; HEAPF32[(p + 24) >> 2] = ay; HEAPF32[(p + 28) >> 2] = az;
      HEAPU32[WsrPhone.u32(20)] = (write + 1) >>> 0;
      return true;
    },
  },

  wsr_phone_attach__deps: ['$WsrPhone'],
  wsr_phone_attach: (state, size, reportsOffset, ringSize) => {
    WsrPhone.state = state;
    WsrPhone.reports = state + reportsOffset;
    WsrPhone.ring = ringSize;
    if (typeof Module['onWsrPhoneReady'] === 'function') setTimeout(() => Module['onWsrPhoneReady'](), 0);
  },
});
