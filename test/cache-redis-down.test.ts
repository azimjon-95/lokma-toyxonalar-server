// Redis ishlamasa ham server uzilmasligi kerak: so'rovlar xotira keshi + loader orqali o'tadi.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = 'redis://127.0.0.1:1'; // hech kim tinglamaydi

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const { cached, bump, initCache, closeCache, cacheStatus } = await import('../src/infrastructure/cache.js');
await initCache();
after(async () => { await closeCache(); });

test('Redis o‘chiq: kesh xotirada ishlaydi, xato tashlamaydi, tez qaytadi', async () => {
  let calls = 0;
  const load = async () => ++calls;
  const t0 = Date.now();
  assert.equal(await cached('down', '', { ttl: 30 }, load), 1);
  assert.equal(await cached('down', '', { ttl: 30 }, load), 1);
  bump('venues');
  assert.equal(await cached('down', '', { ttl: 30 }, load), 2, 'bekor qilish Redis\'siz ham ishlaydi');
  assert.ok(Date.now() - t0 < 2000, `Redis kutilmadi (${Date.now() - t0} ms)`);
  assert.equal(cacheStatus().redis, 'down');
});
