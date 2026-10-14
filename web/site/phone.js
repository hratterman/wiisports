// Phone side of the phone-as-Wii-Remote link. Reads the motion sensors and on-screen buttons and
// streams them to the game tab: over a direct WebRTC data channel when one can be opened, otherwise
// relayed through the signaling WebSocket (web/cloudflare/worker.js). See phone-protocol.js.
(function () {
  'use strict';
  const P = window.WsrPhoneProtocol;
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
    if (document.visibilityState === 'hidden') { buttons = 0; flags = 0; send(); }
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

  // ------------------------------------------------------------------------------------------ transport
  function send(timeMs) {
    const packet = P.encode(seq++, buttons, flags, timeMs === undefined ? lastSent || performance.now() : timeMs, lastGyro, lastAcc);
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
