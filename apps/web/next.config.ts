import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    // This frontend lives in an isolated Git worktree during design work,
    // while the shared project dependencies remain at the repository root.
    root: path.resolve(__dirname, "../../../.."),
  },
  images: {
    // 75 is Next's default; 90 is used by the homepage hero photograph,
    // whose soft light and silk gradients band and blur at 75.
    qualities: [75, 90],
  },
};

export default nextConfig;
