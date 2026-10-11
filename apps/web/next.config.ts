import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const cryptoStub = fileURLToPath(new URL('./src/stubs/node-crypto.ts', import.meta.url));

interface WebpackConfig {
  resolve: { extensionAlias?: Record<string, string[]> };
  plugins: unknown[];
}
interface WebpackContext {
  isServer: boolean;
  webpack: {
    NormalModuleReplacementPlugin: new (re: RegExp, to: string) => unknown;
  };
}

const config: NextConfig = {
  // @bubbleworks/shared ships TypeScript source with no build step.
  transpilePackages: ['@bubbleworks/shared'],
  // Its imports use NodeNext ".js" specifiers for ".ts" files; webpack's extensionAlias maps them
  // (Turbopack doesn't), so dev and build run on webpack.
  webpack: (cfg: WebpackConfig, { isServer, webpack }: WebpackContext) => {
    cfg.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    // The browser bundle gets a stub for node:crypto (only used to mint ids, server side).
    if (!isServer)
      cfg.plugins.push(new webpack.NormalModuleReplacementPlugin(/^node:crypto$/, cryptoStub));
    return cfg;
  },
};

export default config;
