import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The panel is its own app inside the API's repository, which has a lockfile of its own.
  turbopack: { root: path.join(__dirname) },
};

export default nextConfig;
