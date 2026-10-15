// Phone-as-Wii-Remote glue for the WebAssembly build, linked with --js-library.
// C++ side: runtime/src/platform/web/web_phone.cpp (runtime/include/web_phone.h).
//
// The page's phone link (web/site/phone-link.js) calls these; the runtime drains the ring from the
// virtual Wii Remote on its own schedule, so nothing here ever calls into wasm.
// Every call takes an optional last argument `slot`: 0 (default) is player 1's phone, 1 is player 2's
// (web_phone.h kSlots), each with its own ring.
//   Module.wsrPhone.ready()                         -> true once the runtime attached the ring
//   Module.wsrPhone.setConnected(bool)              phone linked / gone (bumps the generation on link)
//   Module.wsrPhone.setControls(buttons, flags, stickX, stickY)
//                                                   Wii Remote + Nunchuk button bits, kFlag* bits
//                                                   (web_phone.h), Nunchuk stick -1..1 (up positive)
//   Module.wsrPhone.push(timeMs, gx,gy,gz, ax,ay,az) one sensor report, SDL axes, rad/s and m/s^2
//   Module.wsrPhone.setOrientation(w,x,y,z, halfX,halfY) calibrated pose + screen half-angles (radians),
//                                                   used while flags carry kFlagAbsolute (web_phone.h)
// Module callback (optional): Module.onWsrPhoneReady() once the ring exists.

addToLibrary({
  $WsrPhone__postset: 'WsrPhone.install();',
  $WsrPhone: {
    // Per slot: {state, reports, ring}; filled by wsr_phone_attach.
    slots: [],

    install() {
      Module['wsrPhone'] = {
        'ready': (slot) => !!WsrPhone.slot(slot),
        'setConnected': (on, slot) => WsrPhone.setConnected(on, slot),
        'setControls': (buttons, flags, sx, sy, slot) => WsrPhone.setControls(buttons, flags, sx, sy, slot),
        'push': (t, gx, gy, gz, ax, ay, az, slot) => WsrPhone.push(t, gx, gy, gz, ax, ay, az, slot),
        'debug': (slot) => WsrPhone.debug(slot),
        'setOrientation': (w, x, y, z, hx, hy, slot) => WsrPhone.setOrientation(w, x, y, z, hx, hy, slot),
      };
    },

    slot(slot) { return WsrPhone.slots[slot | 0] || null; },

    // Layout: web_phone.h detail::State.
    u32(s, offset) { return (s.state + offset) >> 2; },

    setConnected(on, slot) {
      const s = WsrPhone.slot(slot);
      if (!s) return false;
      const was = HEAPU32[WsrPhone.u32(s, 4)] !== 0;
      if (on && !was) HEAPU32[WsrPhone.u32(s, 8)] = (HEAPU32[WsrPhone.u32(s, 8)] + 1) >>> 0;
      HEAPU32[WsrPhone.u32(s, 4)] = on ? 1 : 0;
      if (!on) { HEAPU32[WsrPhone.u32(s, 12)] = 0; HEAPU32[WsrPhone.u32(s, 16)] = 0; }
      return true;
    },

    setControls(buttons, flags, sx, sy, slot) {
      const s = WsrPhone.slot(slot);
      if (!s) return false;
      const axis = (v) => Math.max(-1000, Math.min(1000, Math.round((Number(v) || 0) * 1000)));
      HEAPU32[WsrPhone.u32(s, 12)] = buttons >>> 0;
      HEAPU32[WsrPhone.u32(s, 16)] = flags >>> 0;
      HEAP16[(s.state + 28) >> 1] = axis(sx);
      HEAP16[(s.state + 30) >> 1] = axis(sy);
      return true;
    },

    // web_phone.h State.orientation at offset 96, halfX/halfY at 112/116.
    setOrientation(w, x, y, z, hx, hy, slot) {
      const s = WsrPhone.slot(slot);
      if (!s) return false;
      const base = (s.state + 96) >> 2;
      HEAPF32[base] = w; HEAPF32[base + 1] = x; HEAPF32[base + 2] = y; HEAPF32[base + 3] = z;
      HEAPF32[base + 4] = hx; HEAPF32[base + 5] = hy;
      return true;
    },

    // web_phone.h DebugSample at offset 32: what the virtual remote last handed the game.
    debug(slot) {
      const s = WsrPhone.slot(slot);
      if (!s) return null;
      const f = (o) => HEAPF32[(s.state + 32 + o) >> 2];
      const b = (o) => HEAPU8[s.state + 32 + o];
      return {
        pos: [f(0), f(4)], roll: f(8), gyro: [f(12), f(16), f(20)], acc: [f(24), f(28), f(32)],
        stick: [f(36), f(40)], nunchukAcc: [f(44), f(48), f(52)], hold: HEAPU32[(s.state + 32 + 56) >> 2],
        pointerValid: b(60) !== 0, nunchuk: b(61) !== 0, devType: b(62), mplsMode: b(63),
        // The game's MotionPlus solver output (web_phone.h NoteMpls): turns/s, turns, direction rows.
        mpls: HEAPU32[(s.mpls + 60) >> 2] ? Array.from({ length: 15 }, (_, i) => HEAPF32[(s.mpls >> 2) + i]) : null,
      };
    },

    // Report: u64 timeNs, f32 gyro[3], f32 acc[3], u32 pad (40 bytes).
    push(timeMs, gx, gy, gz, ax, ay, az, slot) {
      const s = WsrPhone.slot(slot);
      if (!s) return false;
      const write = HEAPU32[WsrPhone.u32(s, 20)];
      const p = s.reports + (write % s.ring) * 40;
      HEAPU64[p >> 3] = BigInt(Math.max(0, Math.round(timeMs * 1e6)));
      HEAPF32[(p + 8) >> 2] = gx; HEAPF32[(p + 12) >> 2] = gy; HEAPF32[(p + 16) >> 2] = gz;
      HEAPF32[(p + 20) >> 2] = ax; HEAPF32[(p + 24) >> 2] = ay; HEAPF32[(p + 28) >> 2] = az;
      HEAPU32[WsrPhone.u32(s, 20)] = (write + 1) >>> 0;
      return true;
    },
  },

  wsr_phone_attach__deps: ['$WsrPhone'],
  wsr_phone_attach: (slot, state, size, reportsOffset, ringSize) => {
    WsrPhone.slots[slot] = { state, reports: state + reportsOffset, ring: ringSize,
                             mpls: state + reportsOffset + ringSize * 40 };
    if (slot === 0 && typeof Module['onWsrPhoneReady'] === 'function') setTimeout(() => Module['onWsrPhoneReady'](), 0);
  },
});
