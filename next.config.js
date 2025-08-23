/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // don’t fail the build if ESLint finds anything
    ignoreDuringBuilds: true,
  },
  typescript: {
    // don’t fail the build on TS errors either
    ignoreBuildErrors: true,
  },
};

module.exports = nextConfig;
