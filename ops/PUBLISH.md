# Publishing Project Airlock at llm.galenchen.uk

The container listens on `localhost:3000`. Cloudflare Tunnel gives it a public
HTTPS hostname without opening a single port on your router — the tunnel dials
*out* to Cloudflare, so there is no inbound path to your home network.

## Route A — dashboard token (recommended, no browser login on the Mac)

Cloudflare's dashboard creates the tunnel and hands you a token; nothing needs
authorising from the terminal.

1. **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared.**
   Name it `airlock`. Copy the token from the install command it shows —
   the long string after `--token`.

2. Put it in `.env`:

   ```
   TUNNEL_TOKEN="eyJhIjoi...."
   ```

3. In that tunnel's **Public Hostname** tab, add a route:

   | Field | Value |
   | --- | --- |
   | Subdomain | `llm` |
   | Domain | `galenchen.uk` |
   | Service type | `HTTP` |
   | URL | `app:3000` |

   **`app:3000`, not `localhost:3000`.** The tunnel runs as its own container
   and reaches the app over the compose network; `localhost` there would mean
   the tunnel container itself.

4. Start it:

   ```bash
   docker compose --profile tunnel up -d
   docker compose logs -f tunnel        # look for "Registered tunnel connection"
   ```

The tunnel restarts with the rest of the stack and survives reboot, because
`restart: unless-stopped` applies to it too.

## Route B — CLI

Needs a browser login on the Mac to authorise the domain.

### 1. Install and authenticate

```bash
brew install cloudflared
cloudflared tunnel login          # opens a browser; pick galenchen.uk
```

### 2. Create the tunnel and point DNS at it

```bash
cloudflared tunnel create airlock
cloudflared tunnel route dns airlock llm.galenchen.uk
```

`create` writes credentials to `~/.cloudflared/<TUNNEL-ID>.json`. Note the ID.

### 3. Configure it

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

## Either route: tell the app its public name

Auth.js builds OAuth callbacks from `AUTH_URL`. In `.env`:

```
AUTH_URL="https://llm.galenchen.uk"
```

Add the matching redirect URI in Google Cloud Console:

```
https://llm.galenchen.uk/api/auth/callback/google
```

Then `docker compose up -d` to pick up the change.

`AUTH_URL` does double duty — Auth.js builds OAuth callbacks from it **and**
derives whether the session cookie carries the `__Secure-` prefix. Behind a
tunnel the container is spoken to over HTTP while the browser is on HTTPS, so
this must be the public HTTPS name or sign-in silently fails to stick.

## Lock it down — do this before any real patient note

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
