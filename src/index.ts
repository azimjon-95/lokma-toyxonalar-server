import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './infrastructure/mongo.js';
import { logger } from './infrastructure/logger.js';
import { startJobs, stopJobs } from './jobs.js';

async function main() {
  await connectDatabase();
  const server = createServer(createApp());
  server.listen(env.PORT, env.HOST, () => logger.info('Server ishga tushdi', { port: env.PORT, env: env.NODE_ENV }));
  startJobs();

  const shutdown = (signal: string) => {
    logger.info('To‘xtatilmoqda', { signal });
    stopJobs();
    server.close(async () => {
      await disconnectDatabase().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => logger.error('unhandledRejection', { error: String(e) }));
}

main().catch((e) => {
  logger.error('Ishga tushmadi', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
