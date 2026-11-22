import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    // This frontend lives in an isolated Git worktree during design work,
    // while the shared project dependencies remain at the repository root.
    root: path.resolve(__dirname, "../../../.."),
  },
};

export default nextConfig;
