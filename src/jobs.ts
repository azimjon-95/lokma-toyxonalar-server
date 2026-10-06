import { releaseExpiredHolds } from './modules/slots/slot.service.js';
import { logger } from './infrastructure/logger.js';

let timer: NodeJS.Timeout | undefined;

export function startJobs(intervalMs = 60_000) {
  const tick = () => releaseExpiredHolds().catch((e) => logger.error('Hold tozalash xatosi', { error: String(e) }));
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref();
}

export const stopJobs = () => timer && clearInterval(timer);
