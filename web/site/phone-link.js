// Game-tab side of the phone-as-Wii-Remote link. Shows a pairing code, accepts the phone's
// connection (WebRTC data channel, or packets relayed through the signaling WebSocket when a
// direct connection fails) and writes each packet into the runtime's ring (Module.wsrPhone,
// web/js/library_wsr_phone.js). See phone-protocol.js for the packet format.
(function () {
  'use strict';
  const P = window.WsrPhoneProtocol;
  const STALE_MS = 1500;

  const PLAYERS = 2;
  let code = '';

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return Array.from(bytes, (b) => P.CODE_ALPHABET[b % P.CODE_ALPHABET.length]).join('');
  }

  // Player 1's phone joins the room named by the code, player 2's the code with a 2 after it
  // (phone.js roomFor()), so the signaling servers need no notion of players.
  const roomFor = (slot) => slot ? `${code}${slot + 1}` : code;

  // ------------------------------------------------------------------------------------------ UI
  const style = document.createElement('style');
  style.textContent = `
    #phone-card { position: fixed; right: 16px; bottom: 16px; z-index: 50; max-width: min(340px, calc(100vw - 32px));
      background: rgba(16, 20, 24, 0.92); color: #e8edf2; border-radius: 14px; padding: 14px 16px;
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
    #phone-card[hidden] { display: none; }
    #phone-card .code { font: 700 16px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .15em; }
    #phone-card .url { color: #8bc7ff; word-break: break-all; }
    #phone-card .state { color: #8b97a3; margin-top: 2px; }
    #phone-card .ok { color: #3ecf8e; }
    #phone-card .qrs { display: flex; gap: 12px; margin: 8px 0 4px; }
    #phone-card figure { margin: 0; text-align: center; font-weight: 600; }
    #phone-card .qr { background: #fff; padding: 6px; border-radius: 8px; line-height: 0; }
    #phone-card .qr img { width: 128px; height: 128px; image-rendering: pixelated; }
    #phone-card button { margin-top: 8px; background: #2a323c; color: inherit; border: 0; border-radius: 8px; padding: 6px 10px; font: inherit; }
  `;
  document.head.appendChild(style);

  const card = document.createElement('aside');
  card.id = 'phone-card';
  card.setAttribute('aria-live', 'polite');
  card.innerHTML = `
    <div>Scan with your phone's camera to use it as a Wii Remote:</div>
    <div class="qrs">
      <figure><div class="qr" data-slot="0"></div><figcaption>Player 1</figcaption></figure>
      <figure><div class="qr" data-slot="1"></div><figcaption>Player 2</figcaption></figure>
    </div>
    <div>Or open <span class="url"></span> and enter <span class="code"></span></div>
    <div class="state" data-slot="0"></div>
    <div class="state" data-slot="1"></div>
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

  // One QR code per player: the phone page reads code and player from the address and only needs
  // the Connect tap (motion sensor permission needs a tap on iOS).
  function phoneUrl(slot) {
    return `${location.origin}/phone.html?code=${code}&player=${slot + 1}`;
  }
  function drawQrCodes() {
    if (typeof window.qrcode !== 'function') return;   // qrcode.js missing: the code alone still works
    for (const el of card.querySelectorAll('.qr')) {
      const qr = window.qrcode(0, 'M');
      qr.addData(phoneUrl(Number(el.dataset.slot)));
      qr.make();
      el.innerHTML = qr.createImgTag(4, 0);
      el.querySelector('img').alt = `QR code for Player ${Number(el.dataset.slot) + 1}`;
    }
  }

  function render() {
    card.querySelector('.code').textContent = code;
    for (const link of links) {
      const state = card.querySelector(`.state[data-slot="${link.slot}"]`);
      const who = `Player ${link.slot + 1}`;
      if (link.linked) {
        state.textContent = `${who}: phone connected (${link.mode}).`;
        state.className = 'state ok';
      } else {
        state.textContent = link.ws && link.ws.readyState === WebSocket.OPEN
          ? `${who}: waiting for a phone...` : `${who}: connecting to the pairing service...`;
        state.className = 'state';
      }
    }
  }

  // ------------------------------------------------------------------------------------------ runtime
  function runtime(slot) {
    const m = window.Module && window.Module.wsrPhone;
    return m && m.ready(slot) ? m : null;
  }

  // ------------------------------------------------------------------------------------------ one player's link
  class Link {
    constructor(slot) {
      this.slot = slot;
      this.ws = null;
      this.pc = null;
      this.lastPacketAt = 0;
      this.linked = false;
      this.mode = '';
    }

    setLinked(on, how) {
      if (on === this.linked && (!on || how === this.mode)) return;
      this.linked = on;
      this.mode = how || '';
      const rt = runtime(this.slot);
      if (rt) rt.setConnected(on, this.slot);
      // Collapse the card a few seconds after a phone links; the toolbar button brings it back.
      if (on) setTimeout(() => { if (links.every((l) => l.linked || !l.everLinked)) card.hidden = true; }, 4000);
      if (on) this.everLinked = true;
      render();
    }

    onPacket(data, how) {
      const p = P.decode(data);
      if (!p) return;
      this.lastPacketAt = performance.now();
      if (!this.linked || this.mode !== how) this.setLinked(true, how);
      // The ring only exists once the runtime has polled the remote, so the link state is re-asserted
      // with every packet rather than once.
      const slot = this.slot;
      const rt = runtime(slot);
      if (!rt) return;
      rt.setConnected(true, slot);
      if (p.orientation) rt.setOrientation(p.orientation[0], p.orientation[1], p.orientation[2], p.orientation[3], p.half[0], p.half[1], slot);
      // Orientation first: the runtime only looks at it once the Absolute flag below says it is valid.
      rt.setControls(p.buttons, p.orientation ? p.flags : p.flags & ~P.FLAGS.Absolute, p.stick[0], p.stick[1], slot);
      rt.push(p.timeMs, p.gyro[0], p.gyro[1], p.gyro[2], p.acc[0], p.acc[1], p.acc[2], slot);
    }

    connect() {
      const ws = this.ws = new WebSocket(P.signalUrl(roomFor(this.slot), 'screen'));
      ws.binaryType = 'arraybuffer';
      ws.onopen = render;
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') { this.onPacket(e.data, 'relayed'); return; }
        const msg = JSON.parse(e.data);
        if (msg.t === 'peer' && !msg.on) { this.closePeer(); this.setLinked(false); }
        else if (msg.t === 'offer') this.answer(msg.sdp);
        else if (msg.t === 'ice' && this.pc && msg.c) this.pc.addIceCandidate(msg.c).catch(() => {});
      };
      ws.onclose = () => {
        this.closePeer();
        this.setLinked(false);
        render();
        setTimeout(() => this.connect(), 2000);
      };
      render();
    }

    async answer(sdp) {
      this.closePeer();
      if (typeof RTCPeerConnection === 'undefined') return;
      const pc = this.pc = new RTCPeerConnection({ iceServers: P.ICE_SERVERS });
      pc.onicecandidate = (e) => {
        if (e.candidate && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'ice', c: e.candidate }));
      };
      pc.ondatachannel = (e) => {
        const channel = e.channel;
        channel.binaryType = 'arraybuffer';
        channel.onmessage = (m) => this.onPacket(m.data, 'direct');
      };
      await pc.setRemoteDescription({ type: 'offer', sdp });
      const reply = await pc.createAnswer();
      await pc.setLocalDescription(reply);
      this.ws.send(JSON.stringify({ t: 'answer', sdp: reply.sdp }));
    }

    closePeer() {
      if (this.pc) { try { this.pc.close(); } catch (_) { /* closed */ } }
      this.pc = null;
    }
  }

  const links = Array.from({ length: PLAYERS }, (_, slot) => new Link(slot));

  setInterval(() => {
    for (const link of links) {
      if (link.linked && performance.now() - link.lastPacketAt > STALE_MS) link.setLinked(false);
    }
  }, 250);

  // Keep one code per browser so a bookmarked phone page keeps working across reloads.
  try { code = localStorage.getItem('wsrRoomCode') || ''; } catch (_) { code = ''; }
  if (!new RegExp(`^[${P.CODE_ALPHABET}]{4}$`).test(code)) {
    code = newCode();
    try { localStorage.setItem('wsrRoomCode', code); } catch (_) { /* private mode */ }
  }
  addToolbarButton();
  drawQrCodes();
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
    for (const link of links) link.connect();
  }
})();
