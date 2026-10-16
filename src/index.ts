import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './infrastructure/mongo.js';
import { logger } from './infrastructure/logger.js';
import { startJobs, stopJobs } from './jobs.js';
import { closeCache, initCache, warmAll } from './infrastructure/cache.js';
import './modules/venues/venue.service.js'; // isitgichlar ro'yxatdan o'tadi

async function main() {
  await connectDatabase();
  await initCache(); // Redis ulanguncha (≤1.5 s) kutiladi
  // Birinchi foydalanuvchi kutmasligi uchun kesh oldindan to'ldiriladi (5 s dan oshmaydi)
  await Promise.race([warmAll(), new Promise((r) => setTimeout(r, 5000))]);
  const server = createServer(createApp());
  server.listen(env.PORT, env.HOST, () => logger.info('Server ishga tushdi', { port: env.PORT, env: env.NODE_ENV }));
  startJobs();

  const shutdown = (signal: string) => {
    logger.info('To‘xtatilmoqda', { signal });
    stopJobs();
    server.close(async () => {
      await closeCache().catch(() => {});
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
