import type { NextConfig } from 'next';

// Where /api/* is forwarded: nginx in front of both API instances (dev:cluster / demo), or the single API (dev).
const API_TARGET = process.env.API_PROXY_TARGET ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  // @ds/shared ships TypeScript source, so Next compiles it like app code.
  transpilePackages: ['@ds/shared'],
  // No gzip from this server: a compressor buffers bytes until it has a block, which stalls the live-update streams
  // (SSE) proxied under /api. Cloudflare compresses normal pages at its edge for public visitors anyway.
  compress: false,
  // Same-origin API: the browser only ever talks to this web app (Phase 7, public demo link).
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_TARGET}/:path*` }];
  },
};

export default nextConfig;
