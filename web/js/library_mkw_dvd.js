// Disc / mod-pack streaming and save persistence for the WebAssembly build of WiiCompiled,
// linked with --js-library (and -lidbfs.js). C++ side: runtime/src/hle/storage/web_disc.cpp.
//
// Streamed trees ("mounts"): the operator's static site holds the extracted DATA tree
// (`disc/sys`, `disc/files`) plus a build-time `disc-manifest.json`, and for a modded product the
// mod pack (`mods/RetroRewind6/`) plus `mods/RetroRewind6-manifest.json`
// (web/tools/make_disc_manifest.py). Reads are HTTP Range requests awaited through JSPI
// (`__async: true`): the calling wasm stack is parked until the bytes arrive; the LRU block cache
// lives on the C++ side. Mount ids match WebDisc::Mount (0 = disc at /disc, 1 = mod pack at
// /mods/<last segment of modRoot>).
//
// Saves: `$HOME` (/home/web_user: Config.toml, the managed NAND, Riivolution saves) is an IDBFS
// mount that is populated before main() runs and persisted to IndexedDB automatically after
// every file close, unlink, rename or mkdir (IDBFS autoPersist), plus on page hide.
//
// Two tabs of one origin share that IndexedDB store, so before mounting it the page takes an
// exclusive Web Lock (navigator.locks, name 'webcompiled-saves') and holds it for the life of the
// document. The first tab gets the lock and persists as above. A later tab cannot get it (it waits
// mkwStorageLockWaitMs, so a reload of the owning tab still works) and runs READ-ONLY: it loads the
// saves that are in IndexedDB but never writes back (no autoPersist, no syncfs), and
// Module.onMkwStorageReadOnly(message) lets the page say so. Without navigator.locks (old browser,
// insecure context) it behaves as before, with a console warning. The lock is acquired inside the
// same run dependency as the mount, so it delays main() but cannot deadlock startup.
//
// Module options (all optional):
//   mkwDiscManifestUrl  disc manifest URL, resolved against the page (default 'disc-manifest.json')
//   mkwDiscBaseUrl      disc tree URL; default: the manifest's "root" resolved against the
//                       manifest URL ('disc/' next to it)
//   mkwProduct          {id: 'WiiCompiled' | 'RetroRewind', modRoot: 'mods/RetroRewind6'};
//                       modRoot (page-relative) enables the mod mount
//   mkwModManifestUrl   mod manifest URL (default modRoot + '-manifest.json')
//   mkwModBaseUrl       mod tree URL (default: that manifest's "root", i.e. modRoot + '/')
//   mkwDiscRetries      attempts per request for network errors / 5xx (default 4)
//   mkwDiscPrefetchManifest  false: do not start fetching manifests at module load
//   mkwPersistence      false keeps saves in memory only (default: on when IndexedDB exists)
//   mkwPersistentDir    mount point of the persistent store (default '/home/web_user')
//   mkwStorageLock      false skips the Web Lock (two tabs may then overwrite each other's saves)
//   mkwStorageLockName  lock name (default 'webcompiled-saves')
//   mkwStorageLockWaitMs how long to wait for the lock before going read-only (default 1500)
//   onMkwStorageError   callback(message) for mount/sync failures
//   onMkwStorageReadOnly callback(message) when another tab owns the save store (read-only mode)
//   mkwDiscCache        false: always stream the disc over the network (no local copy)
//   mkwDiscCacheDelayMs how long after the first disc read the background download starts (10000)
//   onMkwDiscCache      callback(cachedBytes, totalBytes, state) as the local disc copy fills;
//                       state 'filling' | 'complete' | 'stopped'
// Local disc copy (MkwDiscCache, disc mount only): every read over the network costs a round trip
// through whatever sits between the browser and the server, and Resort reads its streamed music
// (Sound/Static/stream/*.brstm) continuously, so a slow request stalls the game thread. Once the
// game is running, the page downloads the whole disc in the background into the Origin Private
// File System, one file per disc path, and reads of a completed file are served from there. The
// copy is keyed by a hash of the manifest, so a different disc starts a fresh copy. Only one tab
// downloads at a time (Web Lock 'wsr-disc-cache'), and the download yields to game reads.
// Module helpers installed here:
//   Module.mkwStorageFlush()  -> Promise; persists the store now (e.g. before closing the tab)
//   Module.mkwStorageStatus   'persistent' | 'readonly' | 'memory' | 'error' (after preRun)

addToLibrary({
  $MkwDvd__deps: ['$MkwStorage', '$MkwDiscCache'],
  $MkwDvd__postset: 'MkwDvd.init();',
  $MkwDvd: {
    // Per mount: {label, manifestPromise, baseUrl}; index = WebDisc::Mount.
    mounts: [],
    warnedNoRange: false,

    init() {
      MkwStorage.install();
      MkwDvd.mounts = [{ label: 'disc' }, { label: 'mod' }];
      // Start the manifest downloads while the wasm module is still compiling.
      if (globalThis.fetch && Module['mkwDiscPrefetchManifest'] !== false) {
        MkwDvd.manifest(0);
        if (MkwDvd.modRoot()) MkwDvd.manifest(1);
      }
    },

    // Module.mkwProduct.modRoot without trailing slashes, or '' when the page has no mod.
    modRoot() {
      const root = Module['mkwProduct']?.['modRoot'];
      return typeof root == 'string' ? root.replace(/[\/\\]+$/, '') : '';
    },

    modMountName() {
      const name = MkwDvd.modRoot().split(/[\/\\]/).pop() ?? '';
      return name === '.' || name === '..' ? '' : name;
    },

    pageUrl() {
      if (globalThis.document?.baseURI) return document.baseURI;
      if (globalThis.location?.href) return location.href;
      return undefined;
    },

    resolveUrl(url, base) {
      try {
        return new URL(url, base).href;
      } catch (e) {
        throw new Error(`cannot resolve URL "${url}"${base ? ` against ${base}` : ''} ` +
                        '(set Module.mkwDiscManifestUrl / mkwModManifestUrl to absolute URLs)');
      }
    },

    // {manifestUrl, baseUrl (explicit override or null), defaultRoot} for a mount.
    sourceFor(mount) {
      if (mount == 0) {
        return {
          manifestUrl: Module['mkwDiscManifestUrl'] || 'disc-manifest.json',
          baseUrl: Module['mkwDiscBaseUrl'] || null,
          defaultRoot: 'disc/',
        };
      }
      const root = MkwDvd.modRoot();
      if (!root && !Module['mkwModManifestUrl']) {
        throw new Error('this page configures no mod pack (Module.mkwProduct.modRoot)');
      }
      return {
        manifestUrl: Module['mkwModManifestUrl'] || `${root}-manifest.json`,
        baseUrl: Module['mkwModBaseUrl'] || null,
        defaultRoot: `${MkwDvd.modMountName()}/`,
      };
    },

    manifest(mount) {
      const state = MkwDvd.mounts[mount];
      return state.manifestPromise ??= MkwDvd.fetchManifest(mount);
    },

    // Resolves to the C++ listing text (see mkw_dvd_load_manifest); never rejects.
    async fetchManifest(mount) {
      const state = MkwDvd.mounts[mount];
      try {
        const source = MkwDvd.sourceFor(mount);
        const manifestUrl = MkwDvd.resolveUrl(source.manifestUrl, MkwDvd.pageUrl());
        const response = await MkwDvd.fetchWithRetry(manifestUrl, {});
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText} for ${manifestUrl}`);
        }
        const manifest = await response.json();
        // Bracket access throughout: JSON field names must survive --closure.
        const files = manifest?.['files'];
        if (manifest?.['format'] !== 'wiicompiled-disc-manifest' || manifest['version'] !== 1 ||
            typeof files !== 'object' || files === null) {
          throw new Error(`${manifestUrl} is not a version 1 WiiCompiled disc manifest`);
        }
        let base = source.baseUrl
          ? MkwDvd.resolveUrl(source.baseUrl, MkwDvd.pageUrl())
          : MkwDvd.resolveUrl(manifest['root'] ?? source.defaultRoot, manifestUrl);
        if (!base.endsWith('/')) base += '/';
        state.baseUrl = base;
        // Waited for here so the game's first reads can already be local; listing the copy is quick.
        if (mount == 0) await MkwDiscCache.open(files);

        const valid = (path) => typeof path == 'string' && path.length > 0 && !/[\t\n\r\0]/.test(path);
        const lines = [`MKWDISC\t1\t${base}`];
        for (const [path, size] of Object.entries(files)) {
          if (!valid(path) || !Number.isSafeInteger(size) || size < 0 || size > 0xFFFFFFFF) {
            throw new Error(`${manifestUrl}: invalid entry ${JSON.stringify(path)}: ${size}`);
          }
          lines.push(`F\t${size}\t${path}`);
        }
        for (const path of manifest['directories'] ?? []) {
          if (!valid(path)) throw new Error(`${manifestUrl}: invalid directory ${JSON.stringify(path)}`);
          lines.push(`D\t${path}`);
        }
        return lines.join('\n') + '\n';
      } catch (e) {
        const message = `could not load the ${state.label} manifest: ${e && e.message || e}`;
        err(`[dvd/web] ${message}`);
        return `ERROR\t${message.replace(/[\t\n\r]/g, ' ')}\n`;
      }
    },

    urlFor(mount, relPath) {
      return MkwDvd.mounts[mount].baseUrl + relPath.split('/').map(encodeURIComponent).join('/');
    },

    // fetch() with retries for network failures and 5xx/429 responses.
    async fetchWithRetry(url, init) {
      const attempts = Math.max(1, Module['mkwDiscRetries'] ?? 4);
      let lastError;
      for (let attempt = 0; attempt < attempts; ++attempt) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 150 * 4 ** (attempt - 1)));
        try {
          const response = await fetch(url, init);
          if (response.status >= 500 || response.status == 429) {
            lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
            continue;
          }
          return response;
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError;
    },

    // Game reads in flight; the background disc download waits while this is non-zero.
    inflight: 0,

    async read(mount, relPath, offset, length, dest) {
      if (!MkwDvd.mounts[mount]?.baseUrl) return -2; // manifest never loaded
      ++MkwDvd.inflight;
      try {
        if (mount == 0) {
          const local = await MkwDiscCache.read(relPath, offset, length);
          if (local) {
            HEAPU8.set(local, dest);
            return local.length;
          }
        }
        return await MkwDvd.readNetwork(mount, relPath, offset, length, dest);
      } finally {
        if (--MkwDvd.inflight == 0) MkwDiscCache.wakeIdle();
      }
    },

    async readNetwork(mount, relPath, offset, length, dest) {
      const url = MkwDvd.urlFor(mount, relPath);
      let response;
      try {
        response = await MkwDvd.fetchWithRetry(url, {
          headers: { 'Range': `bytes=${offset}-${offset + length - 1}` },
        });
      } catch (e) {
        err(`[dvd/web] ${url}: ${e && e.message || e}`);
        return -2;
      }
      if (response.status == 404 || response.status == 410) return -1;
      if (response.status == 416) return 0; // range starts past the server's end of file
      if (response.status != 206 && response.status != 200) {
        err(`[dvd/web] ${url}: HTTP ${response.status} ${response.statusText}`);
        return -2;
      }

      let bytes;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (e) {
        err(`[dvd/web] ${url}: ${e && e.message || e}`);
        return -2;
      }
      let start = 0;
      if (response.status == 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('Content-Range') ?? '');
        if (range && Number(range[1]) != offset) {
          err(`[dvd/web] ${url}: asked for offset ${offset}, server sent ${range[0]}`);
          return -3;
        }
      } else {
        // The server ignored Range and sent the whole file: still correct, just slow.
        if (!MkwDvd.warnedNoRange) {
          MkwDvd.warnedNoRange = true;
          err(`[dvd/web] ${MkwDvd.mounts[mount].baseUrl} does not honor HTTP Range requests; every ` +
              'read downloads the whole file. Host the site on a server with Range support.');
        }
        start = Math.min(offset, bytes.length);
      }
      const count = Math.min(length, bytes.length - start);
      // HEAPU8 is re-read after the awaits: memory may have grown meanwhile.
      HEAPU8.set(bytes.subarray(start, start + count), dest);
      return count;
    },
  },

  $MkwDiscCache__deps: ['$MkwDvd'],
  $MkwDiscCache: {
    enabled: false,
    dir: null,            // OPFS directory of this disc version
    files: new Map(),     // relPath -> File, complete local copies
    sizes: new Map(),     // relPath -> size from the manifest
    queue: [],            // relPaths still to download, in order
    wanted: new Set(),    // relPaths the game read while uncached: downloaded first
    totalBytes: 0,
    cachedBytes: 0,
    started: false,
    stopped: false,
    sawRead: false,       // the game has read the disc (reads can come before open() finishes)
    idleWaiters: [],

    // Opens (or starts) the local copy for this manifest. Never rejects; on any failure the disc
    // simply keeps streaming.
    async open(manifestFiles) {
      if (Module['mkwDiscCache'] === false) return;
      const storage = globalThis.navigator?.storage;
      if (!storage?.getDirectory || typeof FileSystemFileHandle == 'undefined' ||
          !FileSystemFileHandle.prototype.createWritable) {
        return;
      }
      try {
        const entries = Object.entries(manifestFiles).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(entries)));
        const key = 'v-' + Array.from(new Uint8Array(digest).subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');

        const root = await (await storage.getDirectory()).getDirectoryHandle('wsr-disc', { create: true });
        // A copy of another disc version is dead weight: drop it.
        for await (const name of root.keys()) {
          if (name !== key) await root.removeEntry(name, { recursive: true }).catch(() => {});
        }
        const dir = await root.getDirectoryHandle(key, { create: true });
        for (const [path, size] of entries) {
          MkwDiscCache.sizes.set(path, size);
          MkwDiscCache.totalBytes += size;
        }
        // createWritable only commits on close(), so a file with the manifest's size is complete.
        for await (const [name, handle] of dir.entries()) {
          let path = null;
          try { path = decodeURIComponent(name); } catch (e) {}
          const file = handle.kind === 'file' ? await handle.getFile() : null;
          if (file && path !== null && MkwDiscCache.sizes.get(path) === file.size) {
            MkwDiscCache.files.set(path, file);
            MkwDiscCache.cachedBytes += file.size;
          } else {
            await dir.removeEntry(name, { recursive: true }).catch(() => {});
          }
        }
        MkwDiscCache.queue = entries.map(([path]) => path).filter((path) => !MkwDiscCache.files.has(path));
        MkwDiscCache.dir = dir;
        MkwDiscCache.enabled = true;
        // Ask the browser not to evict the copy under storage pressure (granted or not, it works).
        storage.persist?.().catch(() => {});
        MkwDiscCache.report(MkwDiscCache.queue.length ? 'filling' : 'complete');
        if (MkwDiscCache.sawRead) MkwDiscCache.start();
        out(`[dvd/web] local disc copy: ${MkwDiscCache.files.size}/${entries.length} files ` +
            `(${(MkwDiscCache.cachedBytes / 1048576).toFixed(0)}/${(MkwDiscCache.totalBytes / 1048576).toFixed(0)} MB)`);
      } catch (e) {
        err(`[dvd/web] local disc copy unavailable, streaming instead: ${e && e.message || e}`);
      }
    },

    report(state) {
      Module['mkwDiscCacheStatus'] = { 'cached': MkwDiscCache.cachedBytes, 'total': MkwDiscCache.totalBytes, 'state': state };
      try {
        Module['onMkwDiscCache']?.(MkwDiscCache.cachedBytes, MkwDiscCache.totalBytes, state);
      } catch (e) {}
    },

    // Bytes [offset, offset + length) of a completed local file, or null to use the network.
    async read(relPath, offset, length) {
      MkwDiscCache.sawRead = true;
      if (!MkwDiscCache.enabled) return null;
      const file = MkwDiscCache.files.get(relPath);
      if (!file) {
        if (MkwDiscCache.sizes.has(relPath)) MkwDiscCache.wanted.add(relPath);
        MkwDiscCache.start();
        return null;
      }
      try {
        return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
      } catch (e) {
        // The browser dropped or invalidated the file: forget it and fetch it again later.
        err(`[dvd/web] local copy of ${relPath} unreadable (${e && e.message || e}); streaming it`);
        MkwDiscCache.files.delete(relPath);
        MkwDiscCache.cachedBytes -= file.size;
        MkwDiscCache.queue.push(relPath);
        return null;
      }
    },

    wakeIdle() {
      const waiters = MkwDiscCache.idleWaiters;
      MkwDiscCache.idleWaiters = [];
      for (const resolve of waiters) resolve();
    },

    // Resolves once no game read is in flight.
    async gameIdle() {
      while (MkwDvd.inflight > 0) {
        await new Promise((resolve) => MkwDiscCache.idleWaiters.push(resolve));
      }
    },

    // Starts the background download once, a while after the game's first disc read so it does
    // not compete with boot.
    start() {
      if (MkwDiscCache.started || !MkwDiscCache.enabled || !MkwDiscCache.queue.length) return;
      MkwDiscCache.started = true;
      const delay = Module['mkwDiscCacheDelayMs'] ?? 10000;
      setTimeout(() => {
        const locks = globalThis.navigator?.locks;
        if (!locks?.request) { MkwDiscCache.fill(); return; }
        // One downloading tab per browser; a second tab just reads what is complete at its start.
        locks.request('wsr-disc-cache', { ifAvailable: true }, (lock) => lock ? MkwDiscCache.fill() : null)
          .catch(() => {});
      }, delay);
    },

    nextPath() {
      for (const path of MkwDiscCache.wanted) {
        MkwDiscCache.wanted.delete(path);
        const i = MkwDiscCache.queue.indexOf(path);
        if (i >= 0) { MkwDiscCache.queue.splice(i, 1); return path; }
      }
      return MkwDiscCache.queue.shift();
    },

    async fill() {
      let failures = 0;
      for (let path; (path = MkwDiscCache.nextPath()) !== undefined;) {
        if (MkwDiscCache.files.has(path)) continue;
        try {
          await MkwDiscCache.download(path);
          failures = 0;
          MkwDiscCache.report(MkwDiscCache.queue.length ? 'filling' : 'complete');
        } catch (e) {
          const quota = e && e.name === 'QuotaExceededError';
          err(`[dvd/web] background download of ${path} failed: ${e && e.message || e}`);
          if (quota || ++failures >= 5) {
            MkwDiscCache.stopped = true;
            MkwDiscCache.report('stopped');
            err(`[dvd/web] local disc copy stopped${quota ? ' (browser storage is full)' : ''}; the rest streams`);
            return;
          }
          MkwDiscCache.queue.push(path);
          await new Promise((resolve) => setTimeout(resolve, 2000 * failures));
        }
      }
    },

    // Downloads one disc file in chunks, each started only while the game has no read waiting.
    async download(path) {
      const size = MkwDiscCache.sizes.get(path);
      const name = encodeURIComponent(path);
      const handle = await MkwDiscCache.dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      const url = MkwDvd.urlFor(0, path);
      const chunk = 2 * 1024 * 1024;
      try {
        for (let offset = 0; offset < size;) {
          await MkwDiscCache.gameIdle();
          const end = Math.min(size, offset + chunk) - 1;
          // no-store: the copy lives in OPFS; keeping it in the HTTP cache too would store it twice.
          const response = await MkwDvd.fetchWithRetry(url, {
            headers: { 'Range': `bytes=${offset}-${end}` },
            priority: 'low',
            cache: 'no-store',
          });
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (response.status == 200 && bytes.length == size) {
            // The server sent the whole file instead of the range: take it.
            await writable.write({ type: 'write', position: 0, data: bytes });
            offset = size;
            continue;
          }
          if (response.status != 206) throw new Error(`HTTP ${response.status} for a range of ${url}`);
          if (bytes.length != end - offset + 1) throw new Error(`short range from ${url}`);
          await writable.write({ type: 'write', position: offset, data: bytes });
          offset += bytes.length;
        }
        await writable.close();
      } catch (e) {
        await writable.abort().catch(() => {});
        throw e;
      }
      const file = await handle.getFile();
      if (file.size !== size) throw new Error(`local copy of ${path} has ${file.size} bytes, expected ${size}`);
      MkwDiscCache.files.set(path, file);
      MkwDiscCache.cachedBytes += size;
    },
  },

  $MkwStorage__deps: ['$FS', '$IDBFS', '$addOnPreRun', '$addRunDependency', '$removeRunDependency'],
  $MkwStorage: {
    mount: null,
    installed: false,
    readOnly: false,

    install() {
      if (MkwStorage.installed) return;
      MkwStorage.installed = true;
      Module['mkwStorageStatus'] = 'memory';
      Module['mkwStorageFlush'] = () => MkwStorage.flush();
      addOnPreRun(async () => {
        const dir = Module['mkwPersistentDir'] || '/home/web_user';
        if (Module['mkwPersistence'] === false || typeof indexedDB == 'undefined') {
          if (Module['mkwPersistence'] !== false) {
            err('[storage] IndexedDB is unavailable; saves and settings will not persist');
          }
          return;
        }
        addRunDependency('mkw-idbfs');
        try {
          // 'held' | 'busy' (another tab owns the saves) | 'unsupported' (no navigator.locks)
          const lock = await MkwStorage.acquireLock();
          const readOnly = lock === 'busy';
          FS.mkdirTree(dir);
          FS.mount(IDBFS, { autoPersist: !readOnly }, dir);
          await MkwStorage.sync(true);
          if (readOnly) {
            // Saves are visible but this tab never writes them back: MkwStorage.mount stays null,
            // so flush() is a no-op and no autoPersist/pagehide sync can run.
            MkwStorage.readOnly = true;
            Module['mkwStorageStatus'] = 'readonly';
            const message = "This game is open in another tab; progress here won't be saved.";
            err(`[storage] ${message}`);
            Module['onMkwStorageReadOnly']?.(message);
            return;
          }
          MkwStorage.mount = dir;
          Module['mkwStorageStatus'] = 'persistent';
          IDBFS.onAutoPersistStateChanged = (active) => {
            Module['onMkwStorageActivity']?.(active);
          };
          const flushOnHide = () => {
            if (globalThis.document?.visibilityState === 'hidden') MkwStorage.flush();
          };
          globalThis.addEventListener?.('pagehide', () => MkwStorage.flush());
          globalThis.document?.addEventListener('visibilitychange', flushOnHide);
        } catch (e) {
          MkwStorage.reportError(`could not open the persistent store at ${dir}: ${e && e.message || e}`);
          Module['mkwStorageStatus'] = 'error';
        } finally {
          removeRunDependency('mkw-idbfs');
        }
      });
    },

    // Takes the exclusive save-store lock and keeps it until the document goes away (the callback
    // returns a promise that never settles). Never rejects.
    acquireLock() {
      if (Module['mkwStorageLock'] === false) return Promise.resolve('unsupported');
      const locks = globalThis.navigator?.locks;
      if (!locks || typeof locks.request != 'function') {
        console.warn('[storage] navigator.locks is unavailable (old browser or insecure context); ' +
                     "several tabs of this game can overwrite each other's saves");
        return Promise.resolve('unsupported');
      }
      const name = Module['mkwStorageLockName'] || 'webcompiled-saves';
      const waitMs = Module['mkwStorageLockWaitMs'] ?? 1500;
      return new Promise((resolve) => {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), waitMs);
        locks.request(name, { signal: abort.signal }, () => {
          clearTimeout(timer);
          resolve('held');
          return new Promise(() => {});
        }).catch((e) => {
          clearTimeout(timer);
          if (e && e.name === 'AbortError') {
            resolve('busy');
          } else {
            console.warn(`[storage] Web Lock request failed (${e && e.message || e}); continuing without it`);
            resolve('unsupported');
          }
        });
      });
    },

    sync(populate) {
      return new Promise((resolve, reject) => {
        FS.syncfs(populate, (error) => error ? reject(error) : resolve());
      });
    },

    reportError(message) {
      err(`[storage] ${message}`);
      Module['onMkwStorageError']?.(message);
    },

    // Never rejects: a failed sync is reported and leaves the in-memory data intact.
    async flush() {
      if (!MkwStorage.mount) return false;
      try {
        await MkwStorage.sync(false);
        return true;
      } catch (e) {
        MkwStorage.reportError(`saving to IndexedDB failed: ${e && e.message || e}`);
        return false;
      }
    },
  },

  mkw_dvd_load_manifest__deps: ['$MkwDvd', '$stringToNewUTF8'],
  mkw_dvd_load_manifest__async: true,
  mkw_dvd_load_manifest: async (mount) => stringToNewUTF8(await MkwDvd.manifest(mount)),

  mkw_dvd_read__deps: ['$MkwDvd', '$UTF8ToString'],
  mkw_dvd_read__async: true,
  mkw_dvd_read: (mount, relPath, offset, length, dest) =>
    MkwDvd.read(mount, UTF8ToString(relPath), offset, length, dest),

  // Synchronous: the mod mount name ('RetroRewind6') or null when the page configures no mod.
  mkw_dvd_mod_mount_name__deps: ['$MkwDvd', '$stringToNewUTF8'],
  mkw_dvd_mod_mount_name: () => {
    const name = MkwDvd.modMountName();
    return name ? stringToNewUTF8(name) : 0;
  },

  // Persists the save store now and waits for IndexedDB. Returns 1 on success, 0 when there is
  // no persistent store or the sync failed. Optional: autoPersist already syncs after writes.
  mkw_storage_flush__deps: ['$MkwStorage'],
  mkw_storage_flush__async: true,
  mkw_storage_flush: async () => (await MkwStorage.flush()) ? 1 : 0,

  // 1 when $HOME is backed by IndexedDB, 0 when saves only live in memory.
  mkw_storage_is_persistent__deps: ['$MkwStorage'],
  mkw_storage_is_persistent: () => MkwStorage.mount ? 1 : 0,

  // 1 when another tab owns the save store and this one only reads it (nothing is written back).
  mkw_storage_is_readonly__deps: ['$MkwStorage'],
  mkw_storage_is_readonly: () => MkwStorage.readOnly ? 1 : 0,
});
