import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  const shutdown = async (signal: string) => {
    app.fastify.log.info({ signal }, 'shutting down');
    await app.fastify.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.fastify.listen({ port: config.PORT, host: config.HOST });
  app.fastify.log.info(
    { port: config.PORT, demoMode: config.DEMO_MODE, publicUrl: config.SERVER_PUBLIC_URL ?? null },
    'bubbleworks server up',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
