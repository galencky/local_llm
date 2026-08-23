import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root: a stray package-lock.json in a parent directory
  // otherwise makes Turbopack guess wrong.
  turbopack: { root: path.join(__dirname) },
  // The pipeline holds PHI in memory; never expose a source map of it publicly.
  productionBrowserSourceMaps: false,
};

export default nextConfig;
