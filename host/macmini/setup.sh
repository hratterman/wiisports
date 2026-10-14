#!/usr/bin/env bash
# Stand up Wii Sports Resort (browser build) on a Mac: build it from your own disc, serve it with
# wsr-host, and publish it at your hostname behind a Cloudflare Access login.
#
#   host/macmini/setup.sh [all|tools|disc|build|serve|cloudflare|verify|status|stop]
#
# Configuration: host/macmini/wiisports.env (copy wiisports.env.example and fill it in).
# "all" (the default) runs every step in order. Every step is safe to run again: finished work
# is detected and skipped. Logs: $WSR_HOME/logs/. Full runbook: host/macmini/README.md.
#
# Needs macOS on Apple Silicon with the Xcode Command Line Tools (git, python3, clang):
#   xcode-select --install
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
env_file=${WSR_ENV_FILE:-$here/wiisports.env}

say() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() { printf '\nsetup.sh: ERROR: %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------------------------------ pins
# Every download is checked against these SHA-256 values before it is used.
EMSDK_COMMIT=8f685c26ee9f672081e61e22c6aa60fa972d00a9
EMSCRIPTEN_VERSION=6.0.12
DOTNET_URL=https://builds.dotnet.microsoft.com/dotnet/Sdk/8.0.426/dotnet-sdk-8.0.426-osx-arm64.tar.gz
DOTNET_SHA=c4e88383ff1ffcf9e80d91367a83690f77dff32a68c742fab6fa5644173875aa
CMAKE_URL=https://github.com/Kitware/CMake/releases/download/v3.31.8/cmake-3.31.8-macos-universal.tar.gz
CMAKE_SHA=d1449f969c54d5c00886d5b643340d493dfb3c81cb39ee29b35453395c11ebf7
NINJA_URL=https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-mac.zip
NINJA_SHA=89a287444b5b3e98f88a945afa50ce937b8ffd1dcc59c555ad9b1baf855298c9
GO_URL=https://go.dev/dl/go1.24.7.darwin-arm64.tar.gz
GO_SHA=d06bad763f8820d3e29ee11f2c0c71438903c007e772a159c5760a300298302e
NODTOOL_URL=https://github.com/encounter/nod/releases/download/v2.0.0-alpha.10/nodtool-macos-arm64
NODTOOL_SHA=e23ca466999b720c55e6d29c9683fce8cc74451ba64ead2e543d50129f24528a
CLOUDFLARED_URL=https://github.com/cloudflare/cloudflared/releases/download/2025.6.1/cloudflared-darwin-arm64.tgz
CLOUDFLARED_SHA=9cc4c04b3cec473c3bf4342a7b5b6628358953e568fd4682aadb390bac85a23a
EXPECTED_DOL_SHA=855e4ffe4f8d69d172c44b05ec3a4ddb89645bebfadca41c98effab69111d448

LABEL_HOST=com.wiisports.host
LABEL_TUNNEL=com.wiisports.tunnel
# launchd domain: the GUI session when someone is logged in at the Mac, else the per-user domain
# (an SSH-only session has no GUI domain).
launchd_domain() {
    if launchctl print "gui/$(id -u)" >/dev/null 2>&1; then echo "gui/$(id -u)"; else echo "user/$(id -u)"; fi
}

# ------------------------------------------------------------------------------------------ config
[[ -f "$env_file" ]] || die "missing $env_file. Copy host/macmini/wiisports.env.example to wiisports.env and fill it in."
# shellcheck disable=SC1090
source "$env_file"
WSR_HOME=${WSR_HOME:-$HOME/wiisports-host}
WSR_PORT=${WSR_PORT:-8080}
tools=$WSR_HOME/toolchain
bin=$WSR_HOME/bin
logs=$WSR_HOME/logs
site=$WSR_HOME/site
disc_dir=$WSR_HOME/disc
mkdir -p "$tools" "$bin" "$logs" "$disc_dir"
export PATH="$bin:$tools/dotnet:$tools/go/bin:$tools/cmake/CMake.app/Contents/bin:$tools/ninja:$PATH"
export DOTNET_ROOT=$tools/dotnet DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1

sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# fetch URL SHA DEST: download once, verify, keep.
fetch() {
    local url=$1 sha=$2 dest=$3
    if [[ -f "$dest" && "$(sha_of "$dest")" == "$sha" ]]; then return 0; fi
    info "downloading $(basename "$url")"
    curl -fL --retry 3 --progress-bar -o "$dest.part" "$url" || die "download failed: $url"
    local got; got=$(sha_of "$dest.part")
    [[ "$got" == "$sha" ]] || { rm -f "$dest.part"; die "checksum mismatch for $url (got $got, expected $sha)"; }
    mv "$dest.part" "$dest"
}

# ------------------------------------------------------------------------------------------ steps
step_preflight() {
    say "Checking this Mac"
    [[ "$(uname -s)" == Darwin ]] || die "this script is for macOS"
    [[ "$(uname -m)" == arm64 ]] || die "this script is for Apple Silicon (arm64); found $(uname -m)"
    xcode-select -p >/dev/null 2>&1 || die "Xcode Command Line Tools missing. Run: xcode-select --install   then rerun this script."
    command -v git >/dev/null && command -v python3 >/dev/null || die "git and python3 are required (Xcode Command Line Tools)"
    local free_gb; free_gb=$(df -g "$HOME" | awk 'NR==2{print $4}')
    ((free_gb >= 20)) || die "need at least 20 GB free in $HOME (have ${free_gb} GB)"
    info "macOS $(sw_vers -productVersion), $(sysctl -n hw.ncpu) cores, $(( $(sysctl -n hw.memsize) / 1073741824 )) GB RAM, ${free_gb} GB free"
}

step_tools() {
    step_preflight
    say "Installing the toolchain into $tools (nothing system-wide)"
    local dl=$tools/downloads; mkdir -p "$dl"
    if [[ ! -x "$tools/dotnet/dotnet" ]]; then
        fetch "$DOTNET_URL" "$DOTNET_SHA" "$dl/dotnet.tar.gz"
        mkdir -p "$tools/dotnet" && tar -xzf "$dl/dotnet.tar.gz" -C "$tools/dotnet"
    fi
    info ".NET $("$tools/dotnet/dotnet" --version)"
    if [[ ! -x "$tools/cmake/CMake.app/Contents/bin/cmake" ]]; then
        fetch "$CMAKE_URL" "$CMAKE_SHA" "$dl/cmake.tar.gz"
        mkdir -p "$tools/cmake" && tar -xzf "$dl/cmake.tar.gz" -C "$tools/cmake" --strip-components 1
    fi
    info "$(cmake --version | head -n1)"
    if [[ ! -x "$tools/ninja/ninja" ]]; then
        fetch "$NINJA_URL" "$NINJA_SHA" "$dl/ninja.zip"
        mkdir -p "$tools/ninja" && unzip -oq "$dl/ninja.zip" -d "$tools/ninja"
    fi
    info "ninja $(ninja --version)"
    if [[ ! -x "$tools/go/bin/go" ]]; then
        fetch "$GO_URL" "$GO_SHA" "$dl/go.tar.gz"
        tar -xzf "$dl/go.tar.gz" -C "$tools"
    fi
    info "$(go version)"
    fetch "$NODTOOL_URL" "$NODTOOL_SHA" "$bin/nodtool" && chmod +x "$bin/nodtool"
    if [[ ! -x "$bin/cloudflared" ]]; then
        fetch "$CLOUDFLARED_URL" "$CLOUDFLARED_SHA" "$dl/cloudflared.tgz"
        tar -xzf "$dl/cloudflared.tgz" -C "$bin" && chmod +x "$bin/cloudflared"
    fi
    # Downloaded binaries carry the quarantine flag; launchd would refuse to start them.
    xattr -dr com.apple.quarantine "$bin" "$tools" 2>/dev/null || true
    info "$(nodtool --version | head -n1), $(cloudflared --version | head -n1)"
    if [[ ! -d "$tools/emsdk/.git" ]]; then
        git clone -q https://github.com/emscripten-core/emsdk.git "$tools/emsdk"
    fi
    git -C "$tools/emsdk" fetch -q origin "$EMSDK_COMMIT" 2>/dev/null || true
    git -C "$tools/emsdk" checkout -q "$EMSDK_COMMIT"
    if [[ ! -f "$tools/emsdk/.emscripten" ]] || ! grep -q "$EMSCRIPTEN_VERSION" "$tools/emsdk/.emsdk_version" 2>/dev/null; then
        info "installing Emscripten $EMSCRIPTEN_VERSION (a few minutes)"
        (cd "$tools/emsdk" && ./emsdk install "$EMSCRIPTEN_VERSION" && ./emsdk activate "$EMSCRIPTEN_VERSION") >"$logs/emsdk.log" 2>&1 \
            || die "Emscripten install failed; see $logs/emsdk.log"
        echo "$EMSCRIPTEN_VERSION" > "$tools/emsdk/.emsdk_version"
    fi
    info "Emscripten $EMSCRIPTEN_VERSION"
    say "Building wsr-host"
    (cd "$repo/host" && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o "$bin/wsr-host" .)
    info "$bin/wsr-host"
}

disc_image() {
    if [[ -n "${WSR_DISC:-}" ]]; then
        [[ -f "$WSR_DISC" ]] || die "WSR_DISC points at a missing file: $WSR_DISC"
        echo "$WSR_DISC"; return
    fi
    local img=$disc_dir/wsr.rvz
    [[ -f "$img" ]] && { echo "$img"; return; }
    [[ -n "${WSR_DISC_URL:-}" ]] || die "set WSR_DISC (a file on this Mac) or WSR_DISC_URL (a Google Drive share link) in $env_file"
    local id
    id=$(python3 -c 'import re,sys; m=re.search(r"/d/([A-Za-z0-9_-]+)|[?&]id=([A-Za-z0-9_-]+)", sys.argv[1]); print(m.group(1) or m.group(2) if m else "")' "$WSR_DISC_URL")
    [[ -n "$id" ]] || die "WSR_DISC_URL is not a Google Drive file link"
    info "downloading the disc from Google Drive (share it as 'Anyone with the link' while this runs)" >&2
    curl -fL --retry 3 --progress-bar -o "$disc_dir/download.part" \
        "https://drive.usercontent.google.com/download?id=$id&export=download&confirm=t" >&2 || die "Drive download failed"
    if [[ "$(head -c 2 "$disc_dir/download.part")" == "PK" ]]; then
        (cd "$disc_dir" && unzip -oq download.part && rm -f download.part)
        local found; found=$(find "$disc_dir" -maxdepth 2 \( -iname '*.rvz' -o -iname '*.iso' -o -iname '*.wbfs' \) | head -n1)
        [[ -n "$found" ]] || die "the zip from Drive held no .rvz/.iso/.wbfs"
        mv "$found" "$img"
    else
        mv "$disc_dir/download.part" "$img"
    fi
    echo "$img"
}

step_disc() {
    say "Checking the disc"
    local img; img=$(disc_image)
    info "image: $img"
    nodtool info "$img" 2>/dev/null | grep -q 'Game ID: RZTP01' \
        || die "this is not PAL Wii Sports Resort (RZTP01). The standalone disc is needed, not the Wii Sports + Wii Sports Resort bundle."
    info "verifying the whole image against Redump (a minute or two)"
    nodtool verify "$img" >"$logs/verify.log" 2>&1 || true
    grep -q 'Redump: Wii Sports Resort (Europe).*(Rev 1)' "$logs/verify.log" \
        || die "the image did not verify as Wii Sports Resort (Europe) (Rev 1); see $logs/verify.log"
    info "clean Rev 1 dump"
}

step_build() {
    step_tools
    step_disc
    say "Building the game for the browser (20 to 40 minutes the first time)"
    local img; img=$(disc_image)
    # shellcheck disable=SC1091
    EMSDK_QUIET=1 source "$tools/emsdk/emsdk_env.sh" >/dev/null 2>&1
    set +e
    NODTOOL=$bin/nodtool bash "$repo/web/build-wsr.sh" "$img" --out "$site" 2>&1 | tee "$logs/build.log" | grep --line-buffered -E '^==> '
    local rc=${PIPESTATUS[0]}
    set -e
    ((rc == 0)) || die "the build failed (exit $rc); the end of $logs/build.log says why"
    [[ -f "$site/index.html" && -f "$site/products.json" ]] || die "the build finished without a site in $site"
    local dol; dol=$(sha_of "$repo/work/extracted/sys/main.dol")
    [[ "$dol" == "$EXPECTED_DOL_SHA" ]] || die "unexpected main.dol hash after the build: $dol"
    info "site ready: $site ($(du -sh "$site" | awk '{print $1}'))"
}

write_agent() { # label program args...
    local label=$1; shift
    local plist=$HOME/Library/LaunchAgents/$label.plist
    mkdir -p "$HOME/Library/LaunchAgents"
    {
        printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        printf '<plist version="1.0"><dict>\n  <key>Label</key><string>%s</string>\n  <key>ProgramArguments</key><array>\n' "$label"
        for arg in "$@"; do printf '    <string>%s</string>\n' "$arg"; done
        printf '  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n'
        printf '  <key>StandardOutPath</key><string>%s/%s.log</string>\n  <key>StandardErrorPath</key><string>%s/%s.log</string>\n' "$logs" "$label" "$logs" "$label"
        printf '</dict></plist>\n'
    } > "$plist"
    chmod 600 "$plist"
    local domain; domain=$(launchd_domain)
    launchctl bootout "$domain/$label" 2>/dev/null || true
    launchctl bootstrap "$domain" "$plist" || die "launchctl could not load $plist into $domain"
}

step_serve() {
    say "Starting wsr-host on 127.0.0.1:$WSR_PORT (launchd keeps it running)"
    [[ -x "$bin/wsr-host" ]] || die "wsr-host not built; run: host/macmini/setup.sh tools"
    [[ -f "$site/index.html" ]] || die "no site yet; run: host/macmini/setup.sh build"
    write_agent "$LABEL_HOST" "$bin/wsr-host" -dir "$site" -addr "127.0.0.1:$WSR_PORT"
    for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$WSR_PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
    curl -fsS "http://127.0.0.1:$WSR_PORT/healthz" >/dev/null || die "wsr-host did not start; see $logs/$LABEL_HOST.log"
    info "serving $site"
}

step_cloudflare() {
    say "Publishing https://$WSR_HOSTNAME through a Cloudflare Tunnel with an Access login"
    [[ -n "${WSR_HOSTNAME:-}" && -n "${WSR_ALLOW_EMAILS:-}" ]] || die "set WSR_HOSTNAME and WSR_ALLOW_EMAILS in $env_file"
    local token_file=$WSR_HOME/tunnel.token
    if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
        local allow=(); for e in ${WSR_ALLOW_EMAILS//,/ }; do allow+=(--allow "$e"); done
        CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID} \
            python3 "$repo/host/cloudflare_setup.py" --hostname "$WSR_HOSTNAME" "${allow[@]}" \
            --service "http://127.0.0.1:$WSR_PORT" --token-out "$token_file"
    elif [[ -n "${WSR_TUNNEL_TOKEN:-}" ]]; then
        (umask 077; printf '%s' "$WSR_TUNNEL_TOKEN" > "$token_file")
    fi
    [[ -s "$token_file" ]] || die "no tunnel token: set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (preferred) or WSR_TUNNEL_TOKEN in $env_file"
    write_agent "$LABEL_TUNNEL" "$bin/cloudflared" tunnel --no-autoupdate run --token-file "$token_file"
    info "tunnel connector started"
}

step_verify() {
    say "Verifying"
    curl -fsS "http://127.0.0.1:$WSR_PORT/healthz" >/dev/null && info "local server: ok" || die "local server is not answering"
    curl -fsS -o /dev/null "http://127.0.0.1:$WSR_PORT/products.json" && info "site files: ok" || die "site files missing"
    if [[ -n "${WSR_HOSTNAME:-}" ]]; then
        local code loc=""
        for _ in $(seq 1 30); do
            code=$(curl -s -o /dev/null -w '%{http_code}' "https://$WSR_HOSTNAME/" || true)
            loc=$(curl -s -o /dev/null -w '%{redirect_url}' "https://$WSR_HOSTNAME/" || true)
            [[ "$code" == 302 && "$loc" == *cloudflareaccess.com* ]] && break
            sleep 2
        done
        [[ "$code" == 302 && "$loc" == *cloudflareaccess.com* ]] \
            && info "https://$WSR_HOSTNAME: ok (asks for the Access login)" \
            || die "https://$WSR_HOSTNAME answered $code${loc:+ -> $loc}, expected a redirect to the Cloudflare Access login. See $logs/$LABEL_TUNNEL.log"
    fi
    say "Done. Open https://${WSR_HOSTNAME:-127.0.0.1:$WSR_PORT} in Chrome or Edge; on the phone open /phone.html on the same site."
}

step_status() {
    local domain; domain=$(launchd_domain)
    for label in "$LABEL_HOST" "$LABEL_TUNNEL"; do
        if launchctl print "$domain/$label" >/dev/null 2>&1; then
            info "$label: $(launchctl print "$domain/$label" | awk -F'= ' '/state =/{print $2; exit}')"
        else
            info "$label: not installed"
        fi
    done
    curl -fsS "http://127.0.0.1:$WSR_PORT/healthz" >/dev/null 2>&1 && info "local server answers" || info "local server not answering"
}

step_stop() {
    local domain; domain=$(launchd_domain)
    for label in "$LABEL_TUNNEL" "$LABEL_HOST"; do
        launchctl bootout "$domain/$label" 2>/dev/null && info "stopped $label" || true
    done
}

case "${1:-all}" in
    all) step_build; step_serve; step_cloudflare; step_verify ;;
    tools) step_tools ;;
    disc) step_disc ;;
    build) step_build ;;
    serve) step_serve ;;
    cloudflare) step_cloudflare ;;
    verify) step_verify ;;
    status) step_status ;;
    stop) step_stop ;;
    *) die "unknown step '$1' (all, tools, disc, build, serve, cloudflare, verify, status, stop)" ;;
esac
