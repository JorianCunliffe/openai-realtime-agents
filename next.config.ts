import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // don't fail the build if ESLint finds anything
    ignoreDuringBuilds: true,
  },
  typescript: {
    // don't fail the build on TS errors either
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
