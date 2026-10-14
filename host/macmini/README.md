# Hosting Wii Sports Resort on the Mac mini

This is the runbook for standing the site up on the Mac mini. Follow it top to bottom. Every command
is meant to be copied as written. The whole first run takes about an hour, nearly all of it
unattended compiling.

When it is done, `https://wii.henryratterman.com` asks for an email code, then loads the game. The game
runs in the viewer's browser (desktop Chrome or Edge); the Mac mini only serves files and pairs
phones with game tabs.

## What gets installed

Everything lives in `~/wiisports-host` (about 15 GB) and two launchd agents. Nothing is installed
system-wide and no `sudo` is needed.

| Piece | What it does |
| --- | --- |
| `toolchain/` | Emscripten 6.0.12, .NET 8 SDK, CMake, Ninja, Go: only used to build |
| `bin/wsr-host` | Serves the site on `127.0.0.1:8080` and relays phone pairing |
| `bin/cloudflared` | Cloudflare Tunnel connector: makes the site reachable at the hostname |
| `site/` | The built game: page, compiled `.wasm`, extracted disc files |
| `logs/` | Build, server and tunnel logs |

Every downloaded tool is pinned to an exact version and checked against a SHA-256 in `setup.sh`.

## Before you start

The Cloudflare side is already set up for `wii.henryratterman.com`: the tunnel `wiisports`, its DNS
record, and an Access login that only lets in the allowed email addresses. Jamie needs from Henry:

1. **The tunnel token** (a long string starting with `ey`). It goes in `WSR_TUNNEL_TOKEN`. If it is
   lost: Cloudflare dashboard, Zero Trust, Networks, Tunnels, `wiisports`, Configure; the install
   command shown there ends with the token.
2. **The disc.** The Wii Sports Resort RVZ (PAL, `RZTP01`, Rev 1) either copied onto the Mac mini, or in
   Google Drive shared as "Anyone with the link" until setup has downloaded it.

To redo the Cloudflare side from scratch instead (or on another account), put an API token in
`CLOUDFLARE_API_TOKEN` and the account ID in `CLOUDFLARE_ACCOUNT_ID`; `setup.sh cloudflare` then runs
`host/cloudflare_setup.py`. The token needs:

| Scope | Permission | Level |
| --- | --- | --- |
| Account | Cloudflare Tunnel | Edit |
| Account | Access: Apps and Policies | Edit |
| Account | Access: Organizations, Identity Providers, and Groups | Edit |
| Zone (henryratterman.com) | DNS | Edit |
| Zone (henryratterman.com) | Zone | Read |

## Steps (Jamie)

1. Make sure the Xcode Command Line Tools are installed:

   ```sh
   xcode-select -p || xcode-select --install
   ```

   If the second command opens an installer, finish it before going on.

2. Get the code:

   ```sh
   git clone https://github.com/hratterman/wiisports.git ~/wiisports
   cd ~/wiisports
   git checkout claude/compassionate-clarke-ukjwqe
   ```

3. Fill in the configuration:

   ```sh
   cp host/macmini/wiisports.env.example host/macmini/wiisports.env
   chmod 600 host/macmini/wiisports.env
   open -e host/macmini/wiisports.env
   ```

   Set `WSR_DISC` (path to the RVZ on this Mac) or `WSR_DISC_URL` (the Drive link), and
   `WSR_TUNNEL_TOKEN` (from Henry). Leave `WSR_HOSTNAME` as `wii.henryratterman.com` and the
   `CLOUDFLARE_*` lines empty.

4. Keep the Mac awake and logged in, so the server stays up:

   - System Settings, Energy: turn on "Prevent automatic sleeping when the display is off".
   - System Settings, Users & Groups: turn on automatic login for this user (the launchd agents run
     in this user's session).

5. Run everything:

   ```sh
   host/macmini/setup.sh
   ```

   It prints a `==>` line per step. The long one is "Compiling to WebAssembly". It ends with
   `Done. Open https://wii.henryratterman.com ...`. If it stops with `ERROR:`, the message says what
   to fix; fix it and run the same command again. Finished steps are skipped.

6. Switch the Drive link back to Restricted if you used one.

## Checking it

```sh
host/macmini/setup.sh status    # both agents running? local server answering?
host/macmini/setup.sh verify    # local server, site files, and the public hostname's login redirect
```

Then on a laptop: open `https://wii.henryratterman.com` in Chrome, enter the email code, click Start.
On a phone: open `https://wii.henryratterman.com/phone.html`, log in the same way, type the
4-letter code the game shows, hold the phone like a remote (screen up, top edge toward the screen)
and tap Connect.

## Day to day

| Task | Command |
| --- | --- |
| Stop serving | `host/macmini/setup.sh stop` |
| Start again | `host/macmini/setup.sh serve && host/macmini/setup.sh cloudflare` |
| Update after new code | `git pull && host/macmini/setup.sh` |
| Add a person | Cloudflare dashboard, Zero Trust, Access, Policies, `wiisports allowed people`: add the email |
| Logs | `ls ~/wiisports-host/logs/` (`com.wiisports.host.log`, `com.wiisports.tunnel.log`, `build.log`) |

## If something goes wrong

| Symptom | Cause and fix |
| --- | --- |
| `ERROR: Xcode Command Line Tools missing` | Run `xcode-select --install`, finish the installer, rerun. |
| `ERROR: this is not PAL Wii Sports Resort (RZTP01)` | Wrong disc. It must be the standalone PAL disc, not the Wii Sports + Wii Sports Resort bundle and not the US version. |
| `ERROR: checksum mismatch` | A download was corrupted or changed upstream. Rerun once; if it repeats, stop and report the URL. |
| `no tunnel token` | `WSR_TUNNEL_TOKEN` is empty in `wiisports.env`. Get it from Henry (or the dashboard, see "Before you start"). |
| `verify` says the hostname answered 502 or 530 | The tunnel is up but the local server is not: `host/macmini/setup.sh serve`. |
| `launchctl could not load` | Usually nobody is logged in at the Mac. Turn on automatic login (step 4) and reboot, or rerun after logging in. |
| The page says WebGPU or JSPI is missing | The viewer is on Safari or an old browser. Use desktop Chrome or Edge 137+. |
