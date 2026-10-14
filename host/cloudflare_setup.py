#!/usr/bin/env python3
"""Create (or update) everything Cloudflare needs to put wsr-host on the internet behind a login.

    CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \\
    python3 host/cloudflare_setup.py --hostname wii.example.com --allow you@example.com [--allow ...] \\
        [--service http://127.0.0.1:8080] [--token-out tunnel.token]

What it does, idempotently (safe to run again; it finds what it made last time by name):
  1. Zero Trust login method: makes sure the "One-time PIN" identity provider exists (a code is
     emailed to an allowed address; no other account needed).
  2. Tunnel "wiisports" (remotely managed) whose only route is HOSTNAME -> SERVICE.
  3. DNS: HOSTNAME as a proxied CNAME to the tunnel.
  4. Access: a self-hosted application on HOSTNAME with one Allow policy for the --allow emails,
     30-day sessions, so a phone or laptop logs in once a month.
  5. Prints (or writes to --token-out) the tunnel token that `cloudflared tunnel run --token` uses.

API token permissions (Cloudflare dashboard > My Profile > API Tokens > Create Custom Token):
  Account  Cloudflare Tunnel            Edit
  Account  Access: Apps and Policies    Edit
  Account  Access: Organizations, Identity Providers, and Groups   Edit
  Zone     DNS                          Edit   (the zone that holds HOSTNAME)
  Zone     Zone                         Read
Python 3 standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("CLOUDFLARE_API_BASE", "https://api.cloudflare.com/client/v4")  # override for tests
TUNNEL_NAME = "wiisports"
APP_NAME = "Wii Sports Resort"
POLICY_NAME = "wiisports allowed people"
SESSION = "720h"


class CloudflareError(RuntimeError):
    pass


class Client:
    def __init__(self, token: str):
        self.token = token

    def call(self, method: str, path: str, body: dict | None = None, query: dict | None = None):
        url = API + path + ("?" + urllib.parse.urlencode(query) if query else "")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.load(resp)
        except urllib.error.HTTPError as err:
            try:
                payload = json.load(err)
            except Exception:
                raise CloudflareError(f"{method} {path}: HTTP {err.code}") from err
        if not payload.get("success", False):
            errors = "; ".join(f"{e.get('code')}: {e.get('message')}" for e in payload.get("errors", []))
            raise CloudflareError(f"{method} {path}: {errors or payload}")
        return payload.get("result")


def step(text: str) -> None:
    print(f"==> {text}", flush=True)


OTP_HELP = ("add it in the dashboard: Zero Trust > Settings > Authentication > Login methods > "
            "Add new > One-time PIN > Save (or give the API token 'Access: Organizations, Identity "
            "Providers, and Groups: Edit'), then run this again")


def ensure_otp_login(cf: Client, account: str) -> bool:
    """True when the One-time PIN login method exists (afterwards)."""
    step("Zero Trust login method (One-time PIN)")
    try:
        providers = cf.call("GET", f"/accounts/{account}/access/identity_providers") or []
    except CloudflareError as err:
        raise CloudflareError(
            f"{err}\nZero Trust may not be set up on this account yet: open the Cloudflare dashboard, "
            "go to Zero Trust, pick a team name and the Free plan, then run this again.") from err
    if any(p.get("type") == "onetimepin" for p in providers):
        print("    already enabled")
        return True
    try:
        cf.call("POST", f"/accounts/{account}/access/identity_providers",
                {"name": "One-time PIN", "type": "onetimepin", "config": {}})
    except CloudflareError as err:
        print(f"    NOT enabled ({err}).\n    Nobody can log in until it exists: {OTP_HELP}")
        return False
    print("    enabled")
    return True


def ensure_tunnel(cf: Client, account: str, hostname: str, service: str) -> tuple[str, str]:
    step(f"Tunnel '{TUNNEL_NAME}'")
    found = cf.call("GET", f"/accounts/{account}/cfd_tunnel", query={"name": TUNNEL_NAME, "is_deleted": "false"}) or []
    if found:
        tunnel_id = found[0]["id"]
        print(f"    exists: {tunnel_id}")
    else:
        tunnel_id = cf.call("POST", f"/accounts/{account}/cfd_tunnel",
                            {"name": TUNNEL_NAME, "config_src": "cloudflare"})["id"]
        print(f"    created: {tunnel_id}")
    cf.call("PUT", f"/accounts/{account}/cfd_tunnel/{tunnel_id}/configurations", {"config": {"ingress": [
        {"hostname": hostname, "service": service, "originRequest": {}},
        {"service": "http_status:404"},
    ]}})
    print(f"    route: {hostname} -> {service}")
    token = cf.call("GET", f"/accounts/{account}/cfd_tunnel/{tunnel_id}/token")
    return tunnel_id, token


def find_zone(cf: Client, hostname: str) -> tuple[str, str]:
    labels = hostname.split(".")
    for i in range(len(labels) - 1):
        name = ".".join(labels[i:])
        zones = cf.call("GET", "/zones", query={"name": name}) or []
        if zones:
            return zones[0]["id"], name
    raise CloudflareError(f"no Cloudflare zone found for {hostname}; is the domain on this account?")


def ensure_dns(cf: Client, hostname: str, tunnel_id: str) -> None:
    step(f"DNS record {hostname}")
    zone_id, zone_name = find_zone(cf, hostname)
    target = f"{tunnel_id}.cfargotunnel.com"
    record = {"type": "CNAME", "name": hostname, "content": target, "proxied": True,
              "comment": "wiisports tunnel (host/cloudflare_setup.py)"}
    existing = cf.call("GET", f"/zones/{zone_id}/dns_records", query={"name": hostname}) or []
    if existing:
        rec = existing[0]
        if rec["type"] != "CNAME":
            raise CloudflareError(f"{hostname} already has a {rec['type']} record; remove it or pick another hostname")
        cf.call("PUT", f"/zones/{zone_id}/dns_records/{rec['id']}", record)
        print(f"    updated in zone {zone_name}: CNAME {target}")
    else:
        cf.call("POST", f"/zones/{zone_id}/dns_records", record)
        print(f"    created in zone {zone_name}: CNAME {target}")


def ensure_access(cf: Client, account: str, hostname: str, emails: list[str], otp: bool) -> None:
    step(f"Access login in front of {hostname}")
    policy_body = {"name": POLICY_NAME, "decision": "allow", "session_duration": SESSION,
                   "include": [{"email": {"email": e}} for e in emails]}
    policies = cf.call("GET", f"/accounts/{account}/access/policies") or []
    policy = next((p for p in policies if p.get("name") == POLICY_NAME), None)
    if policy:
        policy = cf.call("PUT", f"/accounts/{account}/access/policies/{policy['id']}", policy_body)
    else:
        policy = cf.call("POST", f"/accounts/{account}/access/policies", policy_body)
    print(f"    policy allows: {', '.join(emails)}")
    app_body = {"name": APP_NAME, "type": "self_hosted", "domain": hostname, "session_duration": SESSION,
                # Skip the provider chooser when the email code is the only way in.
                "app_launcher_visible": False, "auto_redirect_to_identity": otp,
                "policies": [{"id": policy["id"], "precedence": 1}]}
    apps = cf.call("GET", f"/accounts/{account}/access/apps") or []
    app = next((a for a in apps if a.get("domain") == hostname or a.get("name") == APP_NAME), None)
    if app:
        cf.call("PUT", f"/accounts/{account}/access/apps/{app['id']}", app_body)
        print("    application updated")
    else:
        cf.call("POST", f"/accounts/{account}/access/apps", app_body)
        print("    application created")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hostname", required=True, help="public name, e.g. wii.example.com")
    ap.add_argument("--allow", action="append", required=True, help="email allowed to log in (repeatable)")
    ap.add_argument("--service", default="http://127.0.0.1:8080", help="where wsr-host listens")
    ap.add_argument("--token-out", help="write the tunnel token to this file (mode 600) instead of printing it")
    a = ap.parse_args()
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not token or not account:
        sys.exit("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (see the docstring for the token's permissions)")
    cf = Client(token)
    try:
        otp = ensure_otp_login(cf, account)
        tunnel_id, tunnel_token = ensure_tunnel(cf, account, a.hostname, a.service)
        ensure_dns(cf, a.hostname, tunnel_id)
        ensure_access(cf, account, a.hostname, a.allow, otp)
    except CloudflareError as err:
        sys.exit(f"cloudflare_setup.py: {err}")
    if a.token_out:
        fd = os.open(a.token_out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(tunnel_token)
        step(f"Tunnel token written to {a.token_out}")
    else:
        step("Tunnel token (keep it private):")
        print(tunnel_token)
    if not otp:
        print(f"\nAlmost done: the One-time PIN login method is missing; {OTP_HELP}.")
        return 2
    print(f"\nDone. https://{a.hostname} will ask for an email code once the tunnel connector runs.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
