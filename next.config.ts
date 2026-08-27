import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["pg", "bullmq", "ioredis"],
  // Typed routes are off deliberately: list screens build hrefs from search
  // and pagination state (`${pathname}?${params}`), which typed routes
  // cannot express without a cast at every call site.
  typedRoutes: false,
};

export default nextConfig;
