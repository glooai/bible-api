import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/search": ["./node_modules/sql.js/dist/sql-wasm.wasm"],
  },
};

export default nextConfig;
