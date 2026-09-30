#!/usr/bin/env python3
"""Turn combined OAuth secrets into the names the server reads.

GitHub won't allow secret names starting with GITHUB_, and it's natural to
paste one value per provider (Google's downloaded client JSON, or
"client_id:client_secret"). This reads GOOGLE_OAUTH and ORVYN_GH_SECRET from
the environment and prints NAME=value lines for whichever of
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GITHUB_CLIENT_ID /
GITHUB_CLIENT_SECRET are not already set. Values go to stdout for the deploy
script to read — never to a log.
"""
import json, os, re, sys

def parse(raw, id_pattern, secret_pattern):
    raw = (raw or "").strip()
    if not raw:
        return None, None
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            node = data.get("web") or data.get("installed") or data
            cid = node.get("client_id") or node.get("clientId") or node.get("id")
            sec = node.get("client_secret") or node.get("clientSecret") or node.get("secret")
            return (str(cid).strip() if cid else None), (str(sec).strip() if sec else None)
    except ValueError:
        pass
    cid = re.search(id_pattern, raw)
    sec = re.search(secret_pattern, raw)
    if cid or sec:
        return (cid.group(0) if cid else None), (sec.group(0) if sec else None)
    parts = [p for p in re.split(r"[\s:,;|]+", raw) if p]
    if len(parts) == 2:
        return parts[0], parts[1]
    if len(parts) == 1:
        return None, parts[0]  # a single value is the secret; the ID comes from a variable
    return None, None

out = {}
g_id, g_sec = parse(os.environ.get("GOOGLE_OAUTH"), r"[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com", r"GOCSPX-[A-Za-z0-9_-]+")
h_id, h_sec = parse(os.environ.get("ORVYN_GH_SECRET"), r"(?:Ov23|Iv1\.|Iv23)[A-Za-z0-9.]+", r"\b[a-f0-9]{40}\b")
for name, value in (("GOOGLE_CLIENT_ID", g_id), ("GOOGLE_CLIENT_SECRET", g_sec), ("GITHUB_CLIENT_ID", h_id), ("GITHUB_CLIENT_SECRET", h_sec)):
    if value and not os.environ.get(name, "").strip() and "\n" not in value:
        out[name] = value
for k, v in out.items():
    print(f"{k}={v}")
