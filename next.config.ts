import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root: a stray package-lock.json in a parent directory
  // otherwise makes Turbopack guess wrong.
  turbopack: { root: path.join(__dirname) },
  // The pipeline holds PHI in memory; never expose a source map of it publicly.
  productionBrowserSourceMaps: false,
  // Emit a self-contained server bundle so the container stays small and does
  // not need node_modules at runtime.
  output: "standalone",

  async headers() {
    return [
      {
        // HTML documents must never be held by a browser or an edge. The root
        // page is prerendered and so shipped with no cache headers at all,
        // which left stale markup pointing at a stale JS chunk — a removed UI
        // element kept reappearing until a manual reload.
        //
        // Hashed assets under /_next/static are deliberately NOT covered here:
        // their filenames change on every build, so caching them is both safe
        // and desirable.
        source: "/((?!_next/static|_next/image).*)",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
        ],
      },
      {
        // Cloudflare was caching /api/auth/csrf and replaying it with the
        // Set-Cookie stripped, so every sign-in failed with MissingCSRF. No
        // API response here is ever cacheable: they are all either
        // session-bearing, per-user, or one-shot.
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, max-age=0" },
          { key: "CDN-Cache-Control", value: "no-store" },
          { key: "Cloudflare-CDN-Cache-Control", value: "no-store" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
    ];
  },
};

export default nextConfig;
