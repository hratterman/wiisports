#!/usr/bin/env bash
# Wii Sports Resort for the browser: one-command build from your own disc.
#
#   web/build-wsr.sh DISC_IMAGE_OR_EXTRACTED_DIR [--out DIR] [--jobs N] [--skip-translate]
#
# DISC_IMAGE_OR_EXTRACTED_DIR is your own PAL Wii Sports Resort (RZTP01, Rev 1) as RVZ / ISO / WBFS /
# any format nodtool reads, or an already extracted DATA partition (a folder with sys/main.dol).
# The script verifies it, translates the game's PowerPC code to C++, compiles everything to
# WebAssembly and writes a static site (default web/dist/) that web/serve.py or the Cloudflare
# deployment (web/cloudflare, docs/hosting.md) can serve. Nothing derived from the disc is ever
# written inside the repo except under work/ and web/dist/, both git-ignored.
#
# Needs: Emscripten 6.0.12 (emcc on PATH or EMSDK set), .NET 8 SDK, CMake >= 3.25, Ninja, Python 3,
# and nodtool (https://github.com/encounter/nod/releases, v2.0.0-alpha.10) unless the input is a folder.
set -euo pipefail

EXPECTED_GAME_ID=RZTP01
EXPECTED_DOL_SHA256=855e4ffe4f8d69d172c44b05ec3a4ddb89645bebfadca41c98effab69111d448
EMSCRIPTEN_TESTED=6.0.12
TARGET=WiiCompiled            # the runtime's CMake product name; the page loads TARGET.js

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
workspace=$(cd "$script_dir/.." && pwd)
step_no=0
step() { step_no=$((step_no + 1)); printf '\n==> [%d] %s\n' "$step_no" "$*"; }
info() { printf '    %s\n' "$*"; }
fail() { printf 'build-wsr.sh: error: %s\n' "$*" >&2; exit 1; }

disc=""
out_dir=$workspace/web/dist
jobs=0
skip_translate=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --out) out_dir=$2; shift 2 ;;
        --jobs) jobs=$2; shift 2 ;;
        --skip-translate) skip_translate=1; shift ;;
        -h|--help) sed -n 2,14p "$0"; exit 0 ;;
        -*) fail "unknown option: $1" ;;
        *) [[ -z "$disc" ]] || fail "only one disc image please"; disc=$1; shift ;;
    esac
done
[[ -n "$disc" ]] || fail "usage: web/build-wsr.sh DISC_IMAGE_OR_EXTRACTED_DIR [--out DIR] [--jobs N]"
[[ -e "$disc" ]] || fail "not found: $disc"
mkdir -p "$out_dir"; out_dir=$(cd "$out_dir" && pwd)

work=$workspace/work
extracted=$work/extracted
generated=$work/generated
cmake_build=$work/build-wasm
mkdir -p "$work"

# ------------------------------------------------------------------------------------------ tools
step "Checking tools"
if ! command -v emcc >/dev/null 2>&1 && [[ -n "${EMSDK:-}" ]]; then
    # shellcheck disable=SC1091
    EMSDK_QUIET=1 source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1 || true
fi
command -v emcc >/dev/null 2>&1 || fail "Emscripten not found. Install emsdk $EMSCRIPTEN_TESTED and source emsdk_env.sh (or set EMSDK)."
emver=$(emcc --version | head -n1 | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)
[[ "$emver" == "$EMSCRIPTEN_TESTED" ]] || info "warning: Emscripten $emver; $EMSCRIPTEN_TESTED is the tested version"
command -v dotnet >/dev/null 2>&1 || fail ".NET 8 SDK not found"
command -v cmake >/dev/null 2>&1 || fail "CMake not found"
command -v ninja >/dev/null 2>&1 || fail "Ninja not found"
python_bin=${PYTHON:-python3}
command -v "$python_bin" >/dev/null 2>&1 || fail "Python 3 not found"
if ((jobs <= 0)); then
    cpus=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
    mem_gib=$(( $(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 8388608) / 1048576 ))
    jobs=$(( cpus < mem_gib / 2 ? cpus : mem_gib / 2 )); ((jobs >= 1)) || jobs=1
fi
info "emcc $emver, $jobs parallel jobs"

# ------------------------------------------------------------------------------------------ disc
step "Preparing the disc"
if [[ -d "$disc" ]]; then
    src=$(cd "$disc" && pwd)
    [[ -f "$src/sys/main.dol" ]] || src=$(dirname "$(dirname "$(find "$src" -maxdepth 3 -path '*/sys/main.dol' | head -n1)")")
    [[ -f "$src/sys/main.dol" ]] || fail "no sys/main.dol in $disc"
    if [[ "$src" != "$(cd "$extracted" 2>/dev/null && pwd -P || true)" ]]; then
        rm -rf "$extracted"; ln -s "$src" "$extracted"
    fi
    info "using the extracted tree at $src"
else
    nodtool_bin=${NODTOOL:-$(command -v nodtool || true)}
    [[ -n "$nodtool_bin" ]] || fail "nodtool not found (set NODTOOL=/path/to/nodtool)"
    stamp=$work/extracted.stamp
    want="$(cd "$(dirname "$disc")" && pwd)/$(basename "$disc")|$(stat -c '%s-%Y' "$disc" 2>/dev/null || stat -f '%z-%m' "$disc")"
    if [[ -f "$extracted/sys/main.dol" && "$(cat "$stamp" 2>/dev/null)" == "$want" ]]; then
        info "reusing the previous extraction"
    else
        rm -rf "$extracted" "$extracted.tmp" "$stamp"
        "$nodtool_bin" extract "$disc" "$extracted.tmp" -q
        found=$(find "$extracted.tmp" -maxdepth 4 -path '*/sys/main.dol' | head -n1)
        [[ -n "$found" ]] || fail "extraction produced no sys/main.dol"
        mv "$(dirname "$(dirname "$found")")" "$extracted"; rm -rf "$extracted.tmp"
        printf '%s' "$want" > "$stamp"
    fi
fi

step "Verifying it is PAL Wii Sports Resort ($EXPECTED_GAME_ID)"
game_id=$(head -c 6 "$extracted/sys/boot.bin" 2>/dev/null || true)
[[ "$game_id" == "$EXPECTED_GAME_ID" ]] || fail "game ID is '$game_id', expected $EXPECTED_GAME_ID (standalone PAL Wii Sports Resort, not the Wii Sports + Wii Sports Resort bundle)"
dol_sha=$( (sha256sum "$extracted/sys/main.dol" 2>/dev/null || shasum -a 256 "$extracted/sys/main.dol") | awk '{print $1}')
[[ "$dol_sha" == "$EXPECTED_DOL_SHA256" ]] || fail "main.dol sha256 $dol_sha does not match the supported revision ($EXPECTED_DOL_SHA256)"
info "game ID and main.dol match"

# ------------------------------------------------------------------------------------------ translate
project=$workspace/projects/wsr/recomp.yml
translator_dll=$workspace/translator/src/Translator.Cli/bin/Release/net8.0/Translator.Cli.dll
export DOTNET_CLI_TELEMETRY_OPTOUT=1
fingerprint=$(cat "$extracted/sys/main.dol" "$project" "$workspace/projects/wsr/MAP.txt" \
    <(find "$workspace/runtime/src" -name '*.cpp' -print0 | sort -z | xargs -0 cat) | \
    (sha256sum 2>/dev/null || shasum -a 256) | awk '{print $1}')
if ((skip_translate)) || [[ "$(cat "$generated/.fingerprint" 2>/dev/null)" == "$fingerprint" ]]; then
    step "Reusing the existing translation"
    [[ -f "$generated/build_shards/shards.cmake" ]] || fail "no previous translation in $generated"
else
    step "Building the translator"
    dotnet build "$workspace/translator/src/Translator.Cli/Translator.Cli.csproj" -c Release -v q
    run_translator() { (cd "$workspace" && dotnet "$translator_dll" "$@"); }
    entry=$(awk '/entry_points:/{getline; gsub(/[- ]/,""); print; exit}' "$project")
    step "Translating the game (about a minute)"
    rm -rf "$generated"; mkdir -p "$generated"
    run_translator translate-recursive "$entry" --project "$project" --output-metadata "$generated/base_translation_output.json"
    run_translator generate-data-init --project "$project"
    run_translator emit-build-shards --project "$project" --base-metadata "$generated/base_translation_output.json" \
        --base-functions-dir "$generated/functions" --native-source-dir "$workspace/runtime/src" \
        --out "$generated/build_shards"
    printf '%s' "$fingerprint" > "$generated/.fingerprint"
fi

# ------------------------------------------------------------------------------------------ compile
step "Configuring the WebAssembly build"
emcmake cmake -S "$workspace/runtime" -B "$cmake_build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DMKW_GENERATED_ROOT="$work" \
    -DMKW_TRANSLATED_SHARD_MANIFEST="$generated/build_shards/shards.cmake" \
    -DMKW_PLATFORM_WEB_DIST="$out_dir" \
    -DMKW_TRANSLATED_COMPILE_JOBS="$jobs"

step "Compiling to WebAssembly (the long step)"
cmake --build "$cmake_build" --target "$TARGET" --parallel "$jobs"

# ------------------------------------------------------------------------------------------ site
step "Assembling $out_dir"
cp -R "$workspace/web/site"/. "$out_dir"/
for ext in .js .wasm; do
    [[ -f "$out_dir/$TARGET$ext" ]] || cp -f "$cmake_build/$TARGET$ext" "$out_dir/" 2>/dev/null || \
        cp -f "$cmake_build/web/$TARGET$ext" "$out_dir/" || fail "$TARGET$ext was not produced"
done
rm -rf "$out_dir/disc"; mkdir -p "$out_dir/disc"
for part in sys files; do cp -R "$extracted/$part" "$out_dir/disc/$part"; done
"$python_bin" "$workspace/web/tools/make_disc_manifest.py" "$out_dir/disc" "$out_dir/disc-manifest.json"
printf '[{"id":"%s","title":"Wii Sports Resort","glue":"%s.js"}]\n' "$TARGET" "$TARGET" > "$out_dir/products.json"
"$python_bin" "$workspace/web/tools/precompress_dist.py" "$out_dir"

cat <<EOF

==> Done: $out_dir ($(du -sh "$out_dir" | awk '{print $1}'))
    Try it locally:  $python_bin web/serve.py --dir "$out_dir"    then open http://127.0.0.1:8080/
    Host it:         python3 web/tools/deploy_cloudflare.py --dist "$out_dir"   (docs/hosting.md)
    Browser:         desktop Chrome or Edge 137+ (WebGPU + JSPI). Phone controller: any phone browser.
EOF
