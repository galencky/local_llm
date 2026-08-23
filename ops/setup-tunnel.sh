#!/bin/bash
# Publish Project Airlock at llm.galenchen.uk over Cloudflare Tunnel.
#
# Run `cloudflared tunnel login` FIRST — it opens a browser to authorise the
# domain and cannot be automated. Then run this.
set -euo pipefail

TUNNEL_NAME="${TUNNEL_NAME:-airlock}"
HOSTNAME_="${AIRLOCK_HOSTNAME:-llm.galenchen.uk}"
CF_DIR="$HOME/.cloudflared"

if [ ! -f "$CF_DIR/cert.pem" ]; then
  echo "Not logged in. Run this first, then re-run me:"
  echo "    cloudflared tunnel login"
  exit 1
fi

if ! cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  echo "==> Creating tunnel '$TUNNEL_NAME'"
  cloudflared tunnel create "$TUNNEL_NAME"
else
  echo "==> Tunnel '$TUNNEL_NAME' already exists"
fi

TUNNEL_ID=$(cloudflared tunnel list --output json 2>/dev/null \
  | python3 -c "import sys,json;print(next(t['id'] for t in json.load(sys.stdin) if t['name']=='$TUNNEL_NAME'))")
echo "    id: $TUNNEL_ID"

echo "==> Routing $HOSTNAME_ to the tunnel"
cloudflared tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$HOSTNAME_"

echo "==> Writing $CF_DIR/config.yml"
cat > "$CF_DIR/config.yml" <<YAML
tunnel: $TUNNEL_ID
credentials-file: $CF_DIR/$TUNNEL_ID.json

ingress:
  - hostname: $HOSTNAME_
    service: http://localhost:3000
    originRequest:
      connectTimeout: 30s
      # A note can take a minute. Do not cut the pipeline's progress stream.
      noHappyEyeballs: false
  - service: http_status:404
YAML

cat <<TXT

Done. Two things left:

  1. Point the app at its public name — in .env:
         AUTH_URL="https://$HOSTNAME_"
     then:  docker compose up -d

  2. Add this redirect URI to your Google OAuth client
     (console.cloud.google.com > APIs & Services > Credentials):
         https://$HOSTNAME_/api/auth/callback/google

Then run the tunnel:
     cloudflared tunnel run $TUNNEL_NAME          # foreground, to try it
     sudo cloudflared service install             # or: survives reboot

TXT
