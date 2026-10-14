# Wii Sports Resort on the Mac mini: setup instructions for Jamie

These instructions are complete: follow them top to bottom and run the commands exactly as written.
Do not improvise around a failure. If a step fails, stop, collect what "When something fails" asks
for, and report it to Henry.

## What you are building

A private website at `https://wii.henryratterman.com` that serves Wii Sports Resort to a browser.

- The Mac mini only serves files and pairs phones with game tabs. The game itself runs in the
  viewer's browser (desktop Chrome or Edge) on their own computer.
- A Cloudflare Tunnel connects the Mac mini to the internet; nothing listens on a public port.
- Cloudflare Access asks every visitor for an email code first. Only Henry's address is allowed.
  The tunnel, DNS record and Access login already exist on Henry's Cloudflare account.
- The game is built on this Mac from Henry's own disc image. Nothing derived from the disc ever goes
  into git or anywhere off this Mac.

Time: about 10 minutes of your attention, then 30 to 60 minutes of unattended building.

## What you need from Henry

1. **The tunnel token.** A long string starting with `eyJ`. Henry gets it from the Cloudflare
   dashboard: Zero Trust, Networks, Tunnels, `wiisports`, Configure; the connector install command
   shown there ends with it.
2. **The disc image.** Wii Sports Resort, PAL, game ID `RZTP01`, Rev 1, as an `.rvz` (or a `.zip`
   holding it). Either:
   - a file copied onto this Mac, or
   - a Google Drive link, shared as "Anyone with the link" while setup runs.

## What gets installed

Everything goes in `~/wiisports-host` (about 15 GB) plus two launchd agents in
`~/Library/LaunchAgents`. Nothing system-wide, no Homebrew, no `sudo`.

| Path | What it is |
| --- | --- |
| `~/wiisports` | This repository (the source and the setup script) |
| `~/wiisports-host/toolchain/` | Emscripten 6.0.12, .NET 8 SDK, CMake, Ninja, Go. Only used to build. |
| `~/wiisports-host/bin/wsr-host` | The web server: serves the game on `127.0.0.1:8080`, relays phone pairing |
| `~/wiisports-host/bin/cloudflared` | Cloudflare's tunnel connector |
| `~/wiisports-host/site/` | The built game: page, compiled `.wasm`, extracted disc files |
| `~/wiisports-host/logs/` | Every log mentioned below |
| `com.wiisports.host`, `com.wiisports.tunnel` | launchd agents that keep the server and tunnel running |

Every downloaded tool is pinned to an exact version and checked against a SHA-256 in `setup.sh`
before it is used.

## Step 1: Check the Mac

Run:

```sh
uname -m                 # must print arm64
sw_vers -productVersion  # any recent macOS
df -h ~                  # need 20 GB free or more
xcode-select -p          # must print a path
```

If `xcode-select -p` prints an error, run `xcode-select --install`, finish the installer that opens,
and run `xcode-select -p` again. The Command Line Tools provide `git`, `python3` and `curl`, which
setup needs.

## Step 2: Keep the Mac awake and logged in

The server runs as launchd agents in this user's session, so the Mac must stay logged in and awake.

1. System Settings, Energy (or Battery, then Options): turn on **Prevent automatic sleeping when the
   display is off**. If you have `sudo`, `sudo pmset -a sleep 0 disksleep 0` does the same.
2. System Settings, Users & Groups: set **Automatically log in as** this user, so a reboot brings
   the server back. (Not available when FileVault is on; then someone must log in after a reboot.)

## Step 3: Get the code

```sh
git clone --branch claude/compassionate-clarke-ukjwqe https://github.com/hratterman/wiisports.git ~/wiisports
cd ~/wiisports
```

If Henry gave you a zip of the repository instead, unzip it so that this file is at
`~/wiisports/host/macmini/README.md`, then `cd ~/wiisports`.

## Step 4: Fill in the configuration

```sh
cp host/macmini/wiisports.env.example host/macmini/wiisports.env
chmod 600 host/macmini/wiisports.env
open -e host/macmini/wiisports.env
```

Set exactly these, and leave everything else as it is:

| Setting | Value |
| --- | --- |
| `WSR_DISC` | Full path to the `.rvz` on this Mac, e.g. `"$HOME/Downloads/Wii Sports Resort (Europe) (En,Fr,De,Es,It) (Rev 1).rvz"`. Leave empty if using a Drive link. |
| `WSR_DISC_URL` | The Google Drive link, if Henry gave you one instead of a file |
| `WSR_TUNNEL_TOKEN` | The tunnel token, inside the quotes |

`WSR_HOSTNAME` stays `wii.henryratterman.com`. The `CLOUDFLARE_*` lines and `WSR_ALLOW_EMAILS` stay
empty. Save and close the file. `wiisports.env` is git-ignored; never commit it or paste it anywhere,
because it holds the tunnel token.

## Step 5: Run the setup

```sh
host/macmini/setup.sh
```

It prints one `==>` line per step. Expect, in order:

```
==> Checking this Mac
==> Installing the toolchain into ~/wiisports-host/toolchain (nothing system-wide)
==> Building wsr-host
==> Checking the disc
==> Building the game for the browser (20 to 40 minutes the first time)
==> [1] Checking tools ... ==> [7] Assembling ...
==> Done: ~/wiisports-host/site (about 1.0G)
==> Starting wsr-host on 127.0.0.1:8080 (launchd keeps it running)
==> Publishing https://wii.henryratterman.com through a Cloudflare Tunnel with an Access login
==> Verifying
    local server: ok
    site files: ok
    tunnel connector: registered with Cloudflare
    https://wii.henryratterman.com: ok (asks for the Access login)
==> Done. Open https://wii.henryratterman.com in Chrome or Edge; on the phone open /phone.html on the same site.
```

The long quiet part is "Compiling to WebAssembly" (832 steps). Let it run; do not interrupt it. If
the run stops with `setup.sh: ERROR: ...`, the message says what is wrong. Fix that one thing and
run the same command again: finished steps are skipped.

If you used a Drive link, tell Henry he can set it back to Restricted now.

## Step 6: Confirm it is up

```sh
host/macmini/setup.sh status
host/macmini/setup.sh verify
```

`status` should show both `com.wiisports.host` and `com.wiisports.tunnel` as `running`, and "local
server answers". `verify` should end with `Done.`

Then report to Henry, using the template in "Reporting back".

## How Henry plays (for reference)

- **Game:** on a laptop or desktop, open `https://wii.henryratterman.com` in Chrome or Edge (not
  Safari), enter the code emailed to him, click Start.
- **Phone as the Wii Remote:** on the phone, open `https://wii.henryratterman.com/phone.html`, log
  in the same way, type the 4-letter code shown on the game screen (the Phone button in the game's
  toolbar shows it again), hold the phone screen up with its top edge pointing at the screen, and
  tap Connect.

## Reporting back

When done, send Henry:

```
Wii Sports Resort host: up
setup.sh verify: <paste the output>
setup.sh status: <paste the output>
Mac: <output of: sw_vers -productVersion; sysctl -n hw.memsize; uname -m>
```

## When something fails

Stop and send Henry:

1. The exact `setup.sh: ERROR:` line.
2. Which step it was in (the last `==>` line before it).
3. The end of the matching log:

| Step | Log to send |
| --- | --- |
| Building the game | `tail -n 60 ~/wiisports-host/logs/build.log` |
| Installing the toolchain (Emscripten) | `tail -n 60 ~/wiisports-host/logs/emsdk.log` |
| Checking the disc | `cat ~/wiisports-host/logs/verify.log` |
| Starting wsr-host | `tail -n 40 ~/wiisports-host/logs/com.wiisports.host.log` |
| Tunnel or verify | `tail -n 60 ~/wiisports-host/logs/com.wiisports.tunnel.log` |

Known errors and their fixes:

| Error | Fix |
| --- | --- |
| `Xcode Command Line Tools missing` | `xcode-select --install`, finish the installer, rerun. |
| `need at least 20 GB free` | Free disk space, rerun. |
| `checksum mismatch for <url>` | Rerun once (a download was cut off). If it repeats, stop and report the URL: the file changed upstream. |
| `Google Drive sent a web page instead of the file` | The Drive file is not shared as "Anyone with the link". Ask Henry to share it, rerun. |
| `this is not PAL Wii Sports Resort (RZTP01)` | Wrong disc. It must be the standalone PAL disc, not the Wii Sports + Wii Sports Resort bundle, not the US version. Ask Henry. |
| `did not verify as Wii Sports Resort (Europe) (Rev 1)` | The dump is damaged or a different revision. Ask Henry for a clean Rev 1 dump. |
| `the build failed` | Send the build log (above). Do not try to fix compiler errors yourself. |
| `launchctl could not load` | Usually nobody is logged in at the Mac. Log in at the Mac (Step 2), rerun. |
| `no tunnel token` | `WSR_TUNNEL_TOKEN` is empty in `wiisports.env`. Get it from Henry. |
| `the tunnel connector has not registered` | Usually a mistyped token. Check `WSR_TUNNEL_TOKEN`, then `host/macmini/setup.sh cloudflare && host/macmini/setup.sh verify`. |
| `answered 502` or `530` | The tunnel is up but the server is not: `host/macmini/setup.sh serve`, then `verify`. |

## Day to day

| Task | Command (from `~/wiisports`) |
| --- | --- |
| Is it up? | `host/macmini/setup.sh status` |
| Full check | `host/macmini/setup.sh verify` |
| Stop serving | `host/macmini/setup.sh stop` |
| Start again | `host/macmini/setup.sh serve && host/macmini/setup.sh cloudflare` |
| Update to new code from Henry | `git pull && host/macmini/setup.sh` |
| Logs | `ls ~/wiisports-host/logs/` |

The agents restart the server and tunnel by themselves if they crash and start them at login.

## Rules

- Never commit `host/macmini/wiisports.env` or paste the tunnel token anywhere.
- Do not change the Cloudflare Access policy, the tunnel, or the DNS record. Henry manages them.
  Adding or removing who can log in is done by Henry in the Cloudflare dashboard (Zero Trust,
  Access, Policies, `wiisports allowed people`).
- Do not expose port 8080 beyond `127.0.0.1`, and do not copy `~/wiisports-host/site` or the disc
  image anywhere else. Both contain the game.
- If you are unsure about a step, ask Henry before acting.

## Starting over from nothing

Only if Henry asks:

```sh
cd ~/wiisports && host/macmini/setup.sh stop
rm -f ~/Library/LaunchAgents/com.wiisports.host.plist ~/Library/LaunchAgents/com.wiisports.tunnel.plist
rm -rf ~/wiisports-host
```

Then start again at Step 5.

To recreate the Cloudflare side on another account or from scratch (Henry's call, not routine): put
an API token in `CLOUDFLARE_API_TOKEN`, the account ID in `CLOUDFLARE_ACCOUNT_ID`, the allowed emails
in `WSR_ALLOW_EMAILS`, and run `host/macmini/setup.sh cloudflare`. The token needs Account:
Cloudflare Tunnel Edit, Account: Access: Apps and Policies Edit, Account: Access: Organizations,
Identity Providers, and Groups Edit, Zone: DNS Edit and Zone: Zone Read for the zone.
