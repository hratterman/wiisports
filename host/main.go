// wsr-host serves the browser build of Wii Sports Resort from one folder and pairs phones with game
// tabs, so a single binary is all a host machine needs. It is the self-hosted twin of
// web/cloudflare/worker.js and speaks the same protocol to web/site/phone.js and phone-link.js.
//
//	wsr-host -dir ./site -addr 127.0.0.1:8080
//
//	GET/HEAD /<path>     files under -dir (index.html for /), with HTTP Range support and the
//	                     precompressed .br / .gz sibling when the client accepts it
//	GET /signal/<room>   WebSocket pairing relay: ?role=screen (game tab) or ?role=phone
//	GET /healthz         "ok"
//
// It does no authentication: bind it to localhost and put Cloudflare Access (through a Cloudflare
// Tunnel) or another login in front of it.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

var (
	roomRE       = regexp.MustCompile(`^[A-Z0-9]{4,12}$`)
	hashedWasm   = regexp.MustCompile(`\.[0-9a-f]{8}\.wasm$`)
	compressible = map[string]bool{".html": true, ".js": true, ".mjs": true, ".css": true, ".json": true,
		".wasm": true, ".map": true, ".svg": true}
	types = map[string]string{".wasm": "application/wasm", ".js": "text/javascript; charset=utf-8",
		".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".map": "application/json",
		".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
		".webmanifest": "application/manifest+json"}
)

func main() {
	dir := flag.String("dir", "site", "folder holding index.html, the wasm and disc/")
	addr := flag.String("addr", "127.0.0.1:8080", "listen address")
	flag.Parse()
	root, err := filepath.Abs(*dir)
	if err != nil {
		log.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "index.html")); err != nil {
		log.Fatalf("no index.html in %s: %v", root, err)
	}
	rooms := &rooms{m: map[string]*room{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	mux.HandleFunc("/signal/", rooms.handle)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { serveFile(w, r, root) })
	srv := &http.Server{Addr: *addr, Handler: logRequests(mux), ReadHeaderTimeout: 10 * time.Second}
	log.Printf("serving %s on http://%s", root, *addr)
	log.Fatal(srv.ListenAndServe())
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/disc/") { // disc reads are many and small; keep the log readable
			log.Printf("%s %s", r.Method, r.URL.Path)
		}
		next.ServeHTTP(w, r)
	})
}

func serveFile(w http.ResponseWriter, r *http.Request, root string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rel := path.Clean("/" + r.URL.Path)
	if strings.HasSuffix(r.URL.Path, "/") {
		rel = path.Join(rel, "index.html")
	}
	full := filepath.Join(root, filepath.FromSlash(rel))
	if !strings.HasPrefix(full, root+string(filepath.Separator)) {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	ext := strings.ToLower(path.Ext(rel))
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	if strings.HasPrefix(rel, "/disc/") || hashedWasm.MatchString(rel) {
		h.Set("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "private, no-cache")
	}
	ctype := types[ext]
	if ctype == "" {
		ctype = mime.TypeByExtension(ext)
	}
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	h.Set("Content-Type", ctype)

	// Whole-file requests prefer a precompressed sibling; Range requests always get the plain file.
	if r.Header.Get("Range") == "" && compressible[ext] {
		accept := r.Header.Get("Accept-Encoding")
		for _, enc := range []struct{ token, suffix string }{{"br", ".br"}, {"gzip", ".gz"}} {
			if !strings.Contains(accept, enc.token) {
				continue
			}
			if f, err := os.Open(full + enc.suffix); err == nil {
				defer f.Close()
				if st, err := f.Stat(); err == nil && !st.IsDir() {
					h.Set("Content-Encoding", enc.token)
					h.Add("Vary", "Accept-Encoding")
					http.ServeContent(w, r, "", st.ModTime(), f)
					return
				}
			}
		}
	}
	f, err := os.Open(full)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	h.Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, "", st.ModTime(), f) // handles Range, If-Range, HEAD, 416
}

// ---------------------------------------------------------------------------------------- pairing

// One room per pairing code: at most one game tab ("screen") and one phone. Messages from one side
// go to the other unchanged; each side hears {"t":"peer","on":bool} when the other comes or goes.
type room struct {
	mu    sync.Mutex
	conns map[string]*websocket.Conn
}

type rooms struct {
	mu sync.Mutex
	m  map[string]*room
}

func (rs *rooms) get(code string) *room {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	r := rs.m[code]
	if r == nil {
		r = &room{conns: map[string]*websocket.Conn{}}
		rs.m[code] = r
	}
	return r
}

func (rs *rooms) dropIfEmpty(code string, r *room) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.conns) == 0 && rs.m[code] == r {
		delete(rs.m, code)
	}
}

func other(role string) string {
	if role == "screen" {
		return "phone"
	}
	return "screen"
}

var peerOn, _ = json.Marshal(map[string]any{"t": "peer", "on": true})
var peerOff, _ = json.Marshal(map[string]any{"t": "peer", "on": false})

func (rs *rooms) handle(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(strings.TrimPrefix(r.URL.Path, "/signal/"))
	role := r.URL.Query().Get("role")
	if !roomRE.MatchString(code) || (role != "screen" && role != "phone") {
		http.Error(w, "bad room or role", http.StatusBadRequest)
		return
	}
	// Same-origin pages only; the login in front of this server already limits who gets here.
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	c.SetReadLimit(64 << 10)
	rm := rs.get(code)
	ctx := r.Context()

	rm.mu.Lock()
	if old := rm.conns[role]; old != nil {
		go func() { _ = old.Close(4000, "replaced") }() // Close waits for the handshake; not under the lock
	}
	rm.conns[role] = c
	peer := rm.conns[other(role)]
	rm.mu.Unlock()
	if peer != nil {
		_ = write(ctx, c, websocket.MessageText, peerOn)
		_ = write(ctx, peer, websocket.MessageText, peerOn)
	}

	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			break
		}
		rm.mu.Lock()
		peer := rm.conns[other(role)]
		rm.mu.Unlock()
		if peer != nil {
			_ = write(ctx, peer, typ, data)
		}
	}

	rm.mu.Lock()
	still := rm.conns[role] == c
	if still {
		delete(rm.conns, role)
	}
	peer = rm.conns[other(role)]
	rm.mu.Unlock()
	if still && peer != nil {
		_ = write(context.Background(), peer, websocket.MessageText, peerOff)
	}
	_ = c.CloseNow()
	rs.dropIfEmpty(code, rm)
}

func write(ctx context.Context, c *websocket.Conn, typ websocket.MessageType, data []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	err := c.Write(ctx, typ, data)
	if errors.Is(err, context.DeadlineExceeded) {
		_ = c.Close(websocket.StatusTryAgainLater, "slow consumer")
	}
	return err
}
