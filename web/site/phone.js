// Phone side of the phone-as-Wii-Remote link. Reads the motion sensors and on-screen buttons and
// streams them to the game tab: over a direct WebRTC data channel when one can be opened, otherwise
// relayed through the signaling WebSocket (web/cloudflare/worker.js). See phone-protocol.js.
(function () {
  'use strict';
  const P = window.WsrPhoneProtocol;
  const Pose = window.WsrPhonePose;
  const DEG = Math.PI / 180;
  const $ = (id) => document.getElementById(id);

  const codeInput = $('code');
  const connectButton = $('connect');
  const errorBox = $('error');
  let room = '';
  let ws = null;
  let pc = null;
  let channel = null;
  let peerOn = false;
  let buttons = 0;
  let flags = 0;
  let seq = 0;
  let accelSign = 1;           // iOS before 17 reported accelerationIncludingGravity with the opposite sign
  let lastGyro = [0, 0, 0];
  let lastAcc = [0, 0, 9.81];
  let lastSent = 0;
  let wakeLock = null;
  let stick = [0, 0];          // Nunchuk stick, -1..1, up positive
  // Absolute pointing (phone-pose.js): the browser's fused orientation, the calibrated screen frame
  // and the screen's half-angles. Pose is sent only once both exist.
  let qDevice = null;
  let qDeviceAt = 0;
  let screen = null;           // earth -> screen rotation from the "middle" calibration step
  let half = null;             // [x, y] radians
  const DEFAULT_HALF = [15 * DEG, 9 * DEG];   // a laptop at arm's length; the corners step measures it

  // ------------------------------------------------------------------------------------------ UI
  function setStatus(text, ok) {
    $('statusText').textContent = text;
    $('dot').classList.toggle('ok', !!ok);
  }

  function showError(text) { errorBox.textContent = text || ''; }

  const params = new URLSearchParams(location.search);
  codeInput.value = (params.get('code') || localStorage.getItem('wsrPhoneCode') || '').toUpperCase();
  const validCode = () => new RegExp(`^[${P.CODE_ALPHABET}]{4}$`).test(codeInput.value.toUpperCase());
  const refreshConnect = () => { connectButton.disabled = !validCode(); };
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    refreshConnect();
  });
  refreshConnect();

  connectButton.addEventListener('click', async () => {
    showError('');
    try {
      await startSensors();
    } catch (err) {
      showError(err.message || String(err));
      return;
    }
    room = codeInput.value.toUpperCase();
    try { localStorage.setItem('wsrPhoneCode', room); } catch (_) { /* private mode */ }
    $('pair').style.display = 'none';
    $('pad').classList.add('on');
    applyNunchuk();
    startCalibration(false);
    goFullscreen();
    connect();
  });

  function bindButtons() {
    for (const el of document.querySelectorAll('[data-btn],[data-flag]')) {
      const bit = el.dataset.btn ? P.BUTTONS[el.dataset.btn] : P.FLAGS[el.dataset.flag];
      const isFlag = !el.dataset.btn;
      const active = new Set();
      const update = () => {
        const down = active.size > 0;
        el.classList.toggle('down', down);
        if (isFlag) flags = down ? flags | bit : flags & ~bit;
        else buttons = down ? buttons | bit : buttons & ~bit;
        send();
      };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* capture is a nicety; the press still counts */ }
        active.add(e.pointerId);
        if (navigator.vibrate) navigator.vibrate(8);
        update();
      });
      const release = (e) => { if (active.delete(e.pointerId)) update(); };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('lostpointercapture', release);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }
  bindButtons();

  // ------------------------------------------------------------------------------------------ Nunchuk
  const nunchukOn = $('nunchukOn');
  const pedalOn = $('pedalOn');
  try {
    nunchukOn.checked = localStorage.getItem('wsrNunchuk') === '1';
    pedalOn.checked = localStorage.getItem('wsrPedal') === '1';
  } catch (_) { /* private mode */ }

  function applyNunchuk() {
    const on = nunchukOn.checked;
    $('pad').classList.toggle('nunchuk', on);
    flags = on ? flags | P.FLAGS.Nunchuk : flags & ~(P.FLAGS.Nunchuk | P.FLAGS.NunchukShake);
    flags = on && pedalOn.checked ? flags | P.FLAGS.Pedal : flags & ~P.FLAGS.Pedal;
    if (!on) { buttons &= ~(P.BUTTONS.C | P.BUTTONS.Z); setStick(0, 0); }
    try {
      localStorage.setItem('wsrNunchuk', on ? '1' : '0');
      localStorage.setItem('wsrPedal', pedalOn.checked ? '1' : '0');
    } catch (_) { /* private mode */ }
    send();
  }
  nunchukOn.addEventListener('change', applyNunchuk);
  pedalOn.addEventListener('change', applyNunchuk);

  const stickEl = $('stick');
  const knob = $('knob');
  let stickPointer = null;
  function setStick(x, y) {
    stick = [x, y];
    const travel = (stickEl.clientWidth - knob.clientWidth) / 2 || 43;
    knob.style.transform = `translate(${x * travel}px, ${-y * travel}px)`;
  }
  function stickFrom(e) {
    const r = stickEl.getBoundingClientRect();
    const travel = (r.width - knob.clientWidth) / 2;
    let dx = (e.clientX - (r.left + r.width / 2)) / travel;
    let dy = (e.clientY - (r.top + r.height / 2)) / travel;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    setStick(dx, -dy);
    send();
  }
  stickEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { stickEl.setPointerCapture(e.pointerId); } catch (_) { /* fine without capture */ }
    stickPointer = e.pointerId;
    stickFrom(e);
  });
  stickEl.addEventListener('pointermove', (e) => { if (e.pointerId === stickPointer) stickFrom(e); });
  const stickRelease = (e) => { if (e.pointerId === stickPointer) { stickPointer = null; setStick(0, 0); send(); } };
  stickEl.addEventListener('pointerup', stickRelease);
  stickEl.addEventListener('pointercancel', stickRelease);
  stickEl.addEventListener('lostpointercapture', stickRelease);

  async function goFullscreen() {
    try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch (_) { /* iOS */ }
    try { await screen.orientation.lock('portrait'); } catch (_) { /* not allowed everywhere */ }
    await keepAwake();
  }

  async function keepAwake() {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && $('pad').classList.contains('on') && !wakeLock) keepAwake();
    if (document.visibilityState === 'hidden') {
      buttons = 0;
      flags &= P.FLAGS.Nunchuk | P.FLAGS.Pedal;   // keep the attachment, drop held controls
      setStick(0, 0);
      send();
    }
  });

  // ------------------------------------------------------------------------------------------ sensors
  async function startSensors() {
    if (typeof DeviceMotionEvent === 'undefined') throw new Error('This browser has no motion sensors.');
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const answer = await DeviceMotionEvent.requestPermission();
      if (answer !== 'granted') throw new Error('Motion access was denied. Allow it in the browser settings and reload.');
    }
    const first = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No motion data. This page needs a phone with a gyroscope, opened over https.')), 3000);
      window.addEventListener('devicemotion', function once(e) {
        if (!e.rotationRate || e.rotationRate.alpha === null) return;
        clearTimeout(timer);
        window.removeEventListener('devicemotion', once);
        resolve(e);
      });
    });
    // The user was told to hold the phone screen up: support force must then be +Z.
    const g = first.accelerationIncludingGravity;
    if (g && g.z !== null && g.z < -4) accelSign = -1;
    window.addEventListener('devicemotion', onMotion);
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try { await DeviceOrientationEvent.requestPermission(); } catch (_) { /* motion alone still works */ }
    }
    window.addEventListener('deviceorientation', (e) => {
      if (e.alpha === null || e.beta === null || e.gamma === null) return;
      qDevice = Pose.quatFromEuler(e.alpha, e.beta, e.gamma);
      qDeviceAt = performance.now();
    });
    setInterval(() => { if (performance.now() - lastSent > 50) send(); }, 50);
  }

  function onMotion(e) {
    const r = e.rotationRate;
    const g = e.accelerationIncludingGravity;
    if (!r || r.alpha === null) return;
    // DeviceMotion: alpha about Z, beta about X, gamma about Y, degrees per second.
    lastGyro = [r.beta * DEG, r.gamma * DEG, r.alpha * DEG];
    if (g && g.x !== null) lastAcc = [g.x * accelSign, g.y * accelSign, g.z * accelSign];
    send(e.timeStamp);
  }

  // ------------------------------------------------------------------------------------------ calibration
  // Like a sensor bar: the middle of the screen fixes the frame (up stays gravity's up), the two
  // corners give the screen's size as seen from where the player stands. The size is kept between
  // visits; the middle is captured again each time (the browser's heading reference is per page).
  const calib = { step: null, corners: false, topLeft: null };
  try {
    const saved = JSON.parse(localStorage.getItem('wsrScreenHalf') || 'null');
    if (Array.isArray(saved) && saved.length === 2 && saved.every((v) => v > 2 * DEG && v < 80 * DEG)) half = saved;
  } catch (_) { /* none saved */ }

  const STEPS = {
    middle: { what: 'Point at the middle of the screen', dot: [50, 50] },
    topLeft: { what: 'Point at the top-left corner of the screen', dot: [0, 0] },
    bottomRight: { what: 'Point at the bottom-right corner of the screen', dot: [100, 100] },
  };

  function showStep() {
    const s = STEPS[calib.step];
    const order = calib.corners ? ['middle', 'topLeft', 'bottomRight'] : ['middle'];
    $('calib').querySelector('.step').textContent = `Calibration ${order.indexOf(calib.step) + 1} of ${order.length}`;
    $('calib').querySelector('.what').textContent = s.what;
    const dot = $('calib').querySelector('.target i');
    dot.style.left = `${s.dot[0]}%`; dot.style.top = `${s.dot[1]}%`;
    $('calibSkip').style.display = calib.step === 'topLeft' ? '' : 'none';
    $('calib').classList.add('on');
  }

  // corners: measure the screen size too (always on the first visit, or from the Calibrate button).
  function startCalibration(corners, tries = 0) {
    if (!qDevice) {
      // The first orientation event can trail the first motion event by a moment.
      if (tries < 10) { setTimeout(() => startCalibration(corners, tries + 1), 200); return; }
      $('hint').textContent = 'This phone gives no orientation, so the cursor uses the gyro alone and may drift. Recenter fixes it.';
      return;
    }
    calib.corners = corners || !half;
    calib.step = 'middle';
    showStep();
    send();
  }

  function finishCalibration() {
    calib.step = null;
    $('calib').classList.remove('on');
    send();
  }

  function captureMiddle() {
    if (!qDevice) return false;
    screen = Pose.screenFrame(Pose.tipDirection(qDevice));
    return true;
  }

  $('calibTap').addEventListener('click', () => {
    if (!qDevice) return;
    if (navigator.vibrate) navigator.vibrate(15);
    if (calib.step === 'middle') {
      captureMiddle();
      if (calib.corners) { calib.step = 'topLeft'; showStep(); } else finishCalibration();
    } else if (calib.step === 'topLeft') {
      calib.topLeft = Pose.tipDirection(qDevice);
      calib.step = 'bottomRight'; showStep();
    } else if (calib.step === 'bottomRight') {
      const measured = Pose.screenHalfAngles(screen, calib.topLeft, Pose.tipDirection(qDevice));
      if (!measured) {
        $('calib').querySelector('.what').textContent = 'That did not look like the screen corners. Point at the top-left corner again';
        calib.step = 'topLeft';
        return;
      }
      half = measured;
      try { localStorage.setItem('wsrScreenHalf', JSON.stringify(half)); } catch (_) { /* private mode */ }
      finishCalibration();
    }
  });
  $('calibSkip').addEventListener('click', () => {
    if (!half) half = DEFAULT_HALF.slice();
    finishCalibration();
  });
  $('calibrate').addEventListener('click', () => startCalibration(true));
  // Recenter: the phone is pointing at the middle right now, so that becomes the frame again.
  document.querySelector('[data-flag="Recenter"]').addEventListener('pointerdown', () => { if (screen) captureMiddle(); });

  function currentPose() {
    if (calib.step || !screen || !half || !qDevice || performance.now() - qDeviceAt > 500) return null;
    return { q: Pose.bodyPose(screen, qDevice), half };
  }

  // ------------------------------------------------------------------------------------------ transport
  function send(timeMs) {
    const pose = currentPose();
    const sendButtons = calib.step ? 0 : buttons;   // taps while calibrating are not game input
    const packet = P.encode(seq++, sendButtons, pose ? flags | P.FLAGS.Absolute : flags & ~P.FLAGS.Absolute,
      timeMs === undefined ? lastSent || performance.now() : timeMs, lastGyro, lastAcc, stick, pose);
    // Packets without a fresh sensor time reuse the previous one, so the runtime only takes their buttons.
    if (timeMs !== undefined) lastSent = timeMs;
    if (channel && channel.readyState === 'open') {
      if (channel.bufferedAmount < 16 * 1024) channel.send(packet);
    } else if (ws && ws.readyState === WebSocket.OPEN && peerOn) {
      if (ws.bufferedAmount < 16 * 1024) ws.send(packet);
    }
  }

  function connect() {
    setStatus(`Connecting to ${room}...`);
    ws = new WebSocket(P.signalUrl(room, 'phone'));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => { if (typeof e.data === 'string') onSignal(JSON.parse(e.data)); };
    ws.onclose = (e) => {
      peerOn = false;
      closePeer();
      if (e.code === 4000) { setStatus('Another phone took over this code'); return; }
      setStatus('Connection lost, retrying...');
      setTimeout(connect, 1500);
    };
    ws.onopen = () => setStatus(`Waiting for the game (code ${room})...`);
  }

  function onSignal(msg) {
    if (msg.t === 'peer') {
      peerOn = msg.on;
      if (msg.on) startPeer();
      else { closePeer(); setStatus(`Waiting for the game (code ${room})...`); }
    } else if (msg.t === 'answer' && pc) {
      pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {});
    } else if (msg.t === 'ice' && pc && msg.c) {
      pc.addIceCandidate(msg.c).catch(() => {});
    }
  }

  async function startPeer() {
    closePeer();
    setStatus('Connected (relayed)', true);
    if (typeof RTCPeerConnection === 'undefined') return;
    pc = new RTCPeerConnection({ iceServers: P.ICE_SERVERS });
    channel = pc.createDataChannel('motion', { ordered: false, maxRetransmits: 0 });
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => setStatus('Connected (direct)', true);
    channel.onclose = () => { if (peerOn) setStatus('Connected (relayed)', true); };
    pc.onicecandidate = (e) => { if (e.candidate && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ice', c: e.candidate })); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ t: 'offer', sdp: offer.sdp }));
  }

  function closePeer() {
    if (channel) { try { channel.close(); } catch (_) { /* closed */ } }
    if (pc) { try { pc.close(); } catch (_) { /* closed */ } }
    channel = null;
    pc = null;
  }
})();
