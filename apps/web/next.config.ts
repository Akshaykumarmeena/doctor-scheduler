import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // @ds/shared ships TypeScript source, so Next compiles it like app code.
  transpilePackages: ['@ds/shared'],
};

export default nextConfig;
