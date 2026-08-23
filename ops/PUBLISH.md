# Publishing Project Airlock at llm.galenchen.uk

The container listens on `localhost:3000`. Cloudflare Tunnel gives it a public
HTTPS hostname without opening a single port on your router — the tunnel dials
*out* to Cloudflare, so there is no inbound path to your home network.

## 1. Install and authenticate

```bash
brew install cloudflared
cloudflared tunnel login          # opens a browser; pick galenchen.uk
```

## 2. Create the tunnel and point DNS at it

```bash
cloudflared tunnel create airlock
cloudflared tunnel route dns airlock llm.galenchen.uk
```

`create` writes credentials to `~/.cloudflared/<TUNNEL-ID>.json`. Note the ID.

## 3. Configure it

`~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-ID>
credentials-file: /Users/galen/.cloudflared/<TUNNEL-ID>.json

ingress:
  - hostname: llm.galenchen.uk
    service: http://localhost:3000
    originRequest:
      # The pipeline streams progress for the length of a note, and a note can
      # take a minute. Do not let the tunnel cut the stream short.
      noTLSVerify: false
      connectTimeout: 30s
      # Server-Sent Events must not be buffered or the progress list freezes.
      disableChunkedEncoding: false
  - service: http_status:404
```

## 4. Tell the app its public name

Auth.js builds OAuth callbacks from `AUTH_URL`. In `.env`:

```
AUTH_URL="https://llm.galenchen.uk"
```

Add the matching redirect URI in Google Cloud Console:

```
https://llm.galenchen.uk/api/auth/callback/google
```

Then `docker compose up -d` to pick up the change.

## 5. Run it as a service

```bash
sudo cloudflared service install     # survives reboot
# or, to try it first:
cloudflared tunnel run airlock
```

## 6. Lock it down — do this before any real patient note

- **Cloudflare Access** in front of the hostname (Zero Trust → Access →
  Applications). This is a second, independent gate: Airlock's own Google
  sign-in is the first. Belt and braces on a PHI service is proportionate.
- **`DEV_LOGIN_ENABLED=false`**. A three-character shared password on a public
  hostname is not authentication. The bypass refuses non-localhost hosts by
  default, but turn it off entirely rather than relying on that.
- **Check `AUTH_ALLOWED_EMAILS`** contains only clinicians who should be there.
- Confirm the banner is gone: with the dev bypass off, the amber warning strip
  at the top of the page disappears.

## What the tunnel does and does not protect

Cloudflare terminates TLS at its edge, so it sees the plaintext of ordinary
HTTPS traffic. That is precisely why Airlock encrypts the note in the browser
before it is sent — Cloudflare relays ciphertext, not clinical text.

The remaining gap, stated plainly: the RSA public key is served from
`/api/keys` over the same tunnel it protects. An attacker controlling the edge
could substitute their own key. Pin `keyId` client-side, or distribute the SPKI
out of band, if that is in your threat model.
