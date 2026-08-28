"use client";

/**
 * The exact bytes that crossed the internet, beside the plaintext they
 * replaced. Everything shown is already in this browser — nothing extra is
 * fetched to render it.
 */
import { Monitor, Radio } from "lucide-react";
import { base64ToBytes, type CryptoEnvelope } from "@/lib/crypto";
import { Drawer, DrawerBody } from "./drawer";
import { WireStat } from "./controls";

/* ------------------------------------------------------------------ */
/* Wire view                                                           */
/* ------------------------------------------------------------------ */

/**
 * The exact bytes that crossed the internet, beside the plaintext they
 * replaced. This is what Cloudflare relays: an RSA-wrapped AES key, a nonce,
 * and ciphertext. Everything shown here is already in the browser — nothing
 * extra is fetched to render it.
 */
export function WireView({
  wire,
  onClose,
}: {
  wire: { envelope: CryptoEnvelope; plaintext: string };
  onClose: () => void;
}) {
  const { envelope, plaintext } = wire;
  const body = JSON.stringify(envelope);

  const keyBytes = base64ToBytes(envelope.encryptedKey ?? "");
  const ivBytes = base64ToBytes(envelope.iv);
  const dataBytes = base64ToBytes(envelope.encryptedData);

  // Decoding ciphertext as UTF-8 is meaningless by design — that is the point.
  const asText = new TextDecoder().decode(dataBytes).slice(0, 400);
  const hex = [...dataBytes.slice(0, 96)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");

  const note = (() => {
    try {
      return (JSON.parse(plaintext) as { text?: string }).text ?? plaintext;
    } catch {
      return plaintext;
    }
  })();

  return (
    <Drawer
      title="What Cloudflare sees"
      label="Wire view"
      subtitle={
        <>
  The literal request body from your last run. Cloudflare terminates HTTPS at its
                edge, so this — not your note — is what it relays.
        </>
      }
      width="3xl"
      onClose={onClose}
    >

        <DrawerBody className="p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                <Monitor className="size-3.5 text-sky-700 dark:text-sky-400" />
                What you typed — stays in this browser
              </h4>
              <pre className="scroll-visible max-h-64 overflow-auto whitespace-pre-wrap rounded border border-sky-500/30 bg-sky-500/5 p-2.5 font-mono text-[11px] leading-relaxed">
                {note}
              </pre>
            </div>
            <div>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                <Radio className="size-3.5 text-violet-700 dark:text-violet-400" />
                What went on the wire
              </h4>
              <pre className="scroll-visible max-h-64 overflow-auto break-all whitespace-pre-wrap rounded border border-violet-500/30 bg-violet-500/5 p-2.5 font-mono text-[11px] leading-relaxed">
                {asText}
              </pre>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded border border-[var(--border)] bg-[var(--border)] text-center">
            <WireStat label="Wrapped AES key" value={`${keyBytes.length} B`} sub="RSA-OAEP-2048" />
            <WireStat label="Nonce (iv)" value={`${ivBytes.length} B`} sub="AES-GCM" />
            <WireStat label="Ciphertext" value={`${dataBytes.length} B`} sub={`${note.length} chars in`} />
          </div>

          <h4 className="mt-4 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
            First 96 bytes, as hex
          </h4>
          <pre className="scroll-visible overflow-x-auto rounded border border-[var(--border)] bg-[var(--background)] p-2.5 font-mono text-[10px] leading-relaxed">
            {hex}
          </pre>

          <h4 className="mt-4 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
            The whole POST body
          </h4>
          <pre className="scroll-visible max-h-48 overflow-auto break-all whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--background)] p-2.5 font-mono text-[10px] leading-relaxed">
            {body}
          </pre>

          <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Why this is unreadable
            </h4>
            <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--muted)]">
              Your browser made a one-time AES-256 key, encrypted the note with it, then locked
              that key with the Mac Mini&apos;s public key. Only the matching private key — which
              never leaves your machine — can unlock it. Cloudflare relays the box without a way
              to open it. Tampering fails too: AES-GCM authenticates the ciphertext, so a single
              flipped bit is rejected rather than silently decrypted into something else.
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--muted)]">
              One honest limit: the public key is served from{" "}
              <code className="text-[var(--foreground)]">/api/keys</code> over this same tunnel. An
              attacker who controlled the edge could substitute their own. This defeats passive
              inspection and incidental logging — not an active edge adversary.
            </p>
          </div>
        </DrawerBody>
    </Drawer>
  );
}
