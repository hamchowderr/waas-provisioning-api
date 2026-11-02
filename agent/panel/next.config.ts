import path from "node:path";
import type { NextConfig } from "next";
import { BASE_PATH } from "./src/lib/base-path";

/** The panel's addresses before it moved under BASE_PATH; open tabs and older WaaS Client versions still use them. */
const OLD_PATHS = ["/", "/editor", "/from-shop", "/callback", "/signin", "/signout", "/api/:path*"];

const nextConfig: NextConfig = {
  // The panel is its own app inside the API's repository, which has a lockfile of its own.
  turbopack: { root: path.join(__dirname) },
  basePath: BASE_PATH,
  // Not permanent (307): a POST stays a POST, and nothing caches the move.
  async redirects() {
    return OLD_PATHS.map((source) => ({
      source,
      destination: source === "/" ? BASE_PATH : `${BASE_PATH}${source}`,
      basePath: false as const,
      permanent: false,
    }));
  },
};

export default nextConfig;
