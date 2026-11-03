import path from "node:path";
import type { NextConfig } from "next";
import { BASE_PATH } from "./src/lib/base-path";

const nextConfig: NextConfig = {
  // The panel is its own app inside the API's repository, which has a lockfile of its own.
  turbopack: { root: path.join(__dirname) },
  // Each website's server sends https://<its domain>/.assistant here.
  basePath: BASE_PATH,
};

export default nextConfig;
