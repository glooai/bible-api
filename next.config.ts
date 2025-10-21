import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/search": [
      "./node_modules/sql.js/dist/sql-wasm.wasm",
      "./data/bible.sqlite",
    ],
  },
  outputFileTracingExcludes: {
    "/api/search": ["./lib/bible/translations/**"],
  },
};

export default nextConfig;
