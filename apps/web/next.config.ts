import type { NextConfig } from 'next';

const config: NextConfig = {
  // @bubbleworks/shared ships TypeScript source with no build step.
  transpilePackages: ['@bubbleworks/shared'],
};

export default config;
