// Cloudflare Worker for the hosted build: serves the static site from R2 and pairs phones with
// game tabs. Put Cloudflare Access in front of the Worker's route so only you can open it; the
// Worker itself does no authentication.
//
//   GET/HEAD /<path>          the site and game files from the GAME bucket (index.html for /),
//                             with HTTP Range support (the runtime streams disc files with Range),
//                             and the precompressed .br sibling when the client accepts it
//   GET /signal/<room>        WebSocket into the PhoneRoom Durable Object for <room>:
//                             ?role=screen (the game tab) or ?role=phone (web/site/phone.html)
//
// Bindings (web/cloudflare/wrangler.toml): GAME (R2 bucket), ROOMS (Durable Object PhoneRoom).

const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', wasm: 'application/wasm', map: 'application/json',
  png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon', webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8',
};
// Precompressed siblings (web/tools/precompress_dist.py) only exist for these.
const COMPRESSIBLE = new Set(['html', 'js', 'mjs', 'css', 'json', 'wasm', 'map', 'svg']);
const ROOM_RE = /^[A-Z0-9]{4,12}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/signal/')) {
      const room = decodeURIComponent(url.pathname.slice('/signal/'.length)).toUpperCase();
      if (!ROOM_RE.test(room)) return new Response('bad room', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    return serveFile(request, env, url);
  },
};

async function serveFile(request, env, url) {
  let key = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (key === '' || key.endsWith('/')) key += 'index.html';
  if (key.split('/').some((part) => part === '..' || part === '.')) return new Response('bad path', { status: 400 });
  const ext = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1).toLowerCase() : '';
  const headers = new Headers({
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    // Disc files never change, and the build content-hashes the wasm name (precompress_dist.py);
    // the page and its scripts may change on redeploy.
    'Cache-Control': key.startsWith('disc/') || /\.[0-9a-f]{8}\.wasm$/.test(key)
      ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  const range = request.headers.get('Range');

  // Whole-file requests for text/wasm prefer the Brotli sibling.
  if (!range && COMPRESSIBLE.has(ext) && /\bbr\b/.test(request.headers.get('Accept-Encoding') || '')) {
    const br = await (request.method === 'HEAD' ? env.GAME.head(key + '.br') : env.GAME.get(key + '.br'));
    if (br) {
      headers.set('Content-Encoding', 'br');
      headers.set('Vary', 'Accept-Encoding');
      headers.set('Content-Length', String(br.size));
      headers.set('ETag', br.httpEtag);
      return new Response(request.method === 'HEAD' ? null : br.body, { headers });
    }
  }

  if (request.method === 'HEAD') {
    const head = await env.GAME.head(key);
    if (!head) return new Response(null, { status: 404 });
    headers.set('Content-Length', String(head.size));
    headers.set('ETag', head.httpEtag);
    return new Response(null, { headers });
  }

  let parsed = null;
  if (range) {
    parsed = parseRange(range);
    if (!parsed) return new Response('bad range', { status: 416 });
  }
  const object = await env.GAME.get(key, parsed ? { range: parsed } : {});
  if (!object) return new Response('not found', { status: 404 });
  headers.set('ETag', object.httpEtag);
  if (!parsed) {
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { headers });
  }
  const start = parsed.suffix !== undefined ? Math.max(0, object.size - parsed.suffix) : parsed.offset;
  if (start >= object.size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${object.size}` } });
  }
  const end = parsed.suffix !== undefined ? object.size - 1
    : Math.min(object.size - 1, parsed.length !== undefined ? parsed.offset + parsed.length - 1 : object.size - 1);
  headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(object.body, { status: 206, headers });
}

// One "bytes=a-b", "bytes=a-" or "bytes=-n" range, as an R2 range option. Multi-range is not used
// by the runtime (web_disc.cpp coalesces) and is rejected.
function parseRange(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  if (m[2] === '') return { offset };
  const last = Number(m[2]);
  return last < offset ? null : { offset, length: last - offset + 1 };
}

// One room per pairing code: at most one game tab ("screen") and one phone. Every text message
// from one side is forwarded to the other unchanged (WebRTC offer/answer/candidates, and the
// motion stream itself when a direct WebRTC connection cannot be made). Each side is told when
// the other arrives or leaves. Uses the WebSocket hibernation API, so an idle room costs nothing.
export class PhoneRoom {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const role = new URL(request.url).searchParams.get('role');
    if (role !== 'screen' && role !== 'phone') return new Response('bad role', { status: 400 });
    // A new socket for a role replaces the old one (page reload, phone relink).
    for (const old of this.state.getWebSockets(role)) old.close(4000, 'replaced');
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server, [role]);
    const peer = this.peer(role);
    if (peer) {
      server.send(JSON.stringify({ t: 'peer', on: true }));
      peer.send(JSON.stringify({ t: 'peer', on: true }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  peer(role) {
    return this.state.getWebSockets(role === 'screen' ? 'phone' : 'screen')[0] || null;
  }

  roleOf(ws) {
    return this.state.getTags(ws)[0];
  }

  webSocketMessage(ws, message) {
    const peer = this.peer(this.roleOf(ws));
    if (peer) peer.send(message);
  }

  webSocketClose(ws) {
    const peer = this.peer(this.roleOf(ws));
    if (peer) peer.send(JSON.stringify({ t: 'peer', on: false }));
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }
}
