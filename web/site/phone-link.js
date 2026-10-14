// Game-tab side of the phone-as-Wii-Remote link. Shows a pairing code, accepts the phone's
// connection (WebRTC data channel, or packets relayed through the signaling WebSocket when a
// direct connection fails) and writes each packet into the runtime's ring (Module.wsrPhone,
// web/js/library_wsr_phone.js). See phone-protocol.js for the packet format.
(function () {
  'use strict';
  const P = window.WsrPhoneProtocol;
  const STALE_MS = 1500;

  let room = '';
  let ws = null;
  let pc = null;
  let lastPacketAt = 0;
  let linked = false;
  let mode = '';

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return Array.from(bytes, (b) => P.CODE_ALPHABET[b % P.CODE_ALPHABET.length]).join('');
  }

  // ------------------------------------------------------------------------------------------ UI
  const style = document.createElement('style');
  style.textContent = `
    #phone-card { position: fixed; right: 16px; bottom: 16px; z-index: 50; max-width: min(340px, calc(100vw - 32px));
      background: rgba(16, 20, 24, 0.92); color: #e8edf2; border-radius: 14px; padding: 14px 16px;
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
    #phone-card[hidden] { display: none; }
    #phone-card .code { font: 700 30px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .25em; margin: 6px 0; }
    #phone-card .url { color: #8bc7ff; word-break: break-all; }
    #phone-card .state { color: #8b97a3; margin-top: 6px; }
    #phone-card .ok { color: #3ecf8e; }
    #phone-card button { margin-top: 8px; background: #2a323c; color: inherit; border: 0; border-radius: 8px; padding: 6px 10px; font: inherit; }
  `;
  document.head.appendChild(style);

  const card = document.createElement('aside');
  card.id = 'phone-card';
  card.setAttribute('aria-live', 'polite');
  card.innerHTML = `
    <div>Use your phone as the Wii Remote. On the phone, open</div>
    <div class="url"></div>
    <div>and enter</div>
    <div class="code"></div>
    <div class="state">Waiting for a phone...</div>
    <button type="button" class="hide">Hide</button>`;
  document.body.appendChild(card);
  card.querySelector('.url').textContent = `${location.host}/phone.html`;
  card.querySelector('.hide').addEventListener('click', () => { card.hidden = true; });

  function addToolbarButton() {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar || document.getElementById('btn-phone')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'btn-phone';
    b.className = 'chip';
    b.textContent = 'Phone';
    b.title = 'Show the phone pairing code';
    b.addEventListener('click', () => { card.hidden = !card.hidden; });
    toolbar.insertBefore(b, toolbar.firstChild);
  }

  function render() {
    card.querySelector('.code').textContent = room;
    const state = card.querySelector('.state');
    if (linked) {
      state.textContent = `Phone connected (${mode}).`;
      state.className = 'state ok';
    } else {
      state.textContent = ws && ws.readyState === WebSocket.OPEN ? 'Waiting for a phone...' : 'Connecting to the pairing service...';
      state.className = 'state';
    }
  }

  // ------------------------------------------------------------------------------------------ runtime
  function runtime() {
    const m = window.Module && window.Module.wsrPhone;
    return m && m.ready() ? m : null;
  }

  function setLinked(on, how) {
    if (on === linked && (!on || how === mode)) return;
    linked = on;
    mode = how || '';
    const rt = runtime();
    if (rt) rt.setConnected(on);
    // Collapse the card a few seconds after a phone links; the toolbar button brings it back.
    if (on) setTimeout(() => { if (linked) card.hidden = true; }, 4000);
    render();
  }

  function onPacket(data, how) {
    const p = P.decode(data);
    if (!p) return;
    lastPacketAt = performance.now();
    if (!linked || mode !== how) setLinked(true, how);
    // The ring only exists once the runtime has polled the remote, so the link state is re-asserted
    // with every packet rather than once.
    const rt = runtime();
    if (!rt) return;
    rt.setConnected(true);
    rt.setControls(p.buttons, p.flags);
    rt.push(p.timeMs, p.gyro[0], p.gyro[1], p.gyro[2], p.acc[0], p.acc[1], p.acc[2]);
  }

  setInterval(() => {
    if (linked && performance.now() - lastPacketAt > STALE_MS) setLinked(false);
  }, 250);

  // ------------------------------------------------------------------------------------------ transport
  function connect() {
    ws = new WebSocket(P.signalUrl(room, 'screen'));
    ws.binaryType = 'arraybuffer';
    ws.onopen = render;
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') { onPacket(e.data, 'relayed'); return; }
      const msg = JSON.parse(e.data);
      if (msg.t === 'peer' && !msg.on) { closePeer(); setLinked(false); }
      else if (msg.t === 'offer') answer(msg.sdp);
      else if (msg.t === 'ice' && pc && msg.c) pc.addIceCandidate(msg.c).catch(() => {});
    };
    ws.onclose = () => {
      closePeer();
      setLinked(false);
      render();
      setTimeout(connect, 2000);
    };
    render();
  }

  async function answer(sdp) {
    closePeer();
    if (typeof RTCPeerConnection === 'undefined') return;
    pc = new RTCPeerConnection({ iceServers: P.ICE_SERVERS });
    pc.onicecandidate = (e) => { if (e.candidate && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ice', c: e.candidate })); };
    pc.ondatachannel = (e) => {
      const channel = e.channel;
      channel.binaryType = 'arraybuffer';
      channel.onmessage = (m) => onPacket(m.data, 'direct');
    };
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const reply = await pc.createAnswer();
    await pc.setLocalDescription(reply);
    ws.send(JSON.stringify({ t: 'answer', sdp: reply.sdp }));
  }

  function closePeer() {
    if (pc) { try { pc.close(); } catch (_) { /* closed */ } }
    pc = null;
  }

  // Keep one code per browser so a bookmarked phone page keeps working across reloads.
  try { room = localStorage.getItem('wsrRoomCode') || ''; } catch (_) { room = ''; }
  if (!new RegExp(`^[${P.CODE_ALPHABET}]{4}$`).test(room)) {
    room = newCode();
    try { localStorage.setItem('wsrRoomCode', room); } catch (_) { /* private mode */ }
  }
  addToolbarButton();
  // Show the card on the loading screen only: once the game is running it would cover Resort's
  // corner prompts. The toolbar's Phone button brings it back.
  const loader = document.getElementById('loader');
  if (loader) {
    const sync = () => { if (loader.hidden) card.hidden = true; };
    new MutationObserver(sync).observe(loader, { attributes: true, attributeFilter: ['hidden'] });
    sync();
  }
  render();
  if (location.protocol === 'file:') {
    card.querySelector('.state').textContent = 'Phone pairing needs the site to be served over http(s).';
  } else {
    connect();
  }
})();
