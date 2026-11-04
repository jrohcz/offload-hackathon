import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingIncludes: {
    "/api/sell": ["./fixtures/real/generated-used-turntable.webp"],
  },
};

export default nextConfig;
