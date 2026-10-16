/*
 * Kesh benchmark: N ta to'yxona + band seanslar yaratib, GET /api/venues va to'yxona sahifasi tezligini o'lchaydi.
 *   CACHE_ENABLED=false npm run bench     — keshsiz
 *   npm run bench                         — kesh bilan (REDIS_URL bo'lsa Redis)
 * Alohida baza ishlatadi: BENCH_MONGODB_URI (standart mongodb://127.0.0.1:27017/lokma_bench). Mavjud ma'lumotga tegmaydi.
 */
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.BENCH_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/lokma_bench';
process.env.ADMIN_API_KEY = 'bench-admin-key-0123456789abcdef';
process.env.API_RATE_LIMIT = '1000000';

import type { AddressInfo } from 'node:net';

const N = Number(process.env.BENCH_VENUES ?? 300);
const REQS = Number(process.env.BENCH_REQUESTS ?? 400);

const { createApp } = await import('../app.js');
const { connectDatabase, disconnectDatabase } = await import('../infrastructure/mongo.js');
const { initCache, closeCache, cacheStatus, warmAll } = await import('../infrastructure/cache.js');
const { seed } = await import('./seed.js');
const { VenueModel } = await import('../modules/venues/venue.model.js');
const { SlotModel } = await import('../modules/slots/slot.model.js');
const { todayISO, addDaysISO } = await import('../lib/dates.js');
await import('../modules/venues/venue.service.js');

await initCache();
await connectDatabase();
await SlotModel.syncIndexes();
await seed({ fresh: true });

// Mavjud to'yxonalarni N tagacha ko'paytiramiz (Toshkent atrofida tasodifiy joylar)
const base = (await VenueModel.find({}).lean())[0];
const docs = Array.from({ length: N }, (_, i) => {
  const { _id, createdAt, updatedAt, ...rest } = JSON.parse(JSON.stringify(base));
  void _id; void createdAt; void updatedAt;
  return { ...rest, name: `Bench ${i}`, slug: `bench-${i}`, lat: 41.3 + (Math.random() - 0.5) * 0.5, lng: 69.27 + (Math.random() - 0.5) * 0.6, halls: rest.halls.map((h: { _id?: string }) => ({ ...h, _id: undefined })) };
});
const created = await VenueModel.insertMany(docs);
const today = todayISO();
const slots = [];
for (const v of created) {
  for (let d = 0; d < 30; d++) for (const s of ['day', 'evening'] as const) if (Math.random() < 0.45) slots.push({ venue_id: v._id, hall_id: v.halls[0]._id, date: addDaysISO(today, d), session: s, status: 'booked' as const });
}
await SlotModel.insertMany(slots, { ordered: false });
await warmAll();

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const pct = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * p) / 100))];
async function run(label: string, mk: (i: number) => string, concurrency: number) {
  const times: number[] = [];
  let next = 0;
  const worker = async () => {
    while (next < REQS) {
      const i = next++;
      const t0 = performance.now();
      const r = await fetch(url + mk(i));
      await r.arrayBuffer();
      if (r.status !== 200) throw new Error(`${label}: ${r.status}`);
      times.push(performance.now() - t0);
    }
  };
  const t = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wall = performance.now() - t;
  console.log(`${label.padEnd(34)} p50 ${pct(times, 50).toFixed(1).padStart(7)} ms   p95 ${pct(times, 95).toFixed(1).padStart(7)} ms   ${(REQS / (wall / 1000)).toFixed(0).padStart(5)} req/s`);
}
const coord = (i: number) => `lat=${(41.2 + ((i * 37) % 200) / 1000).toFixed(3)}&lng=${(69.15 + ((i * 53) % 250) / 1000).toFixed(3)}`;

console.log(`\nBenchmark: ${N + 8} to'yxona, ${slots.length} band seans, ${REQS} so'rov | kesh: ${cacheStatus().mode}\n`);
await run('GET /api/venues (ketma-ket)', (i) => `/api/venues?${coord(i)}&radius_km=20&sort=distance`, 1);
await run('GET /api/venues (20 parallel)', (i) => `/api/venues?${coord(i)}&radius_km=20&sort=distance`, 20);
await run('GET /api/venues/:slug (sahifa)', (i) => `/api/venues/bench-${i % N}?${coord(i)}`, 1);
await run('GET /api/venues/free-soon', (i) => `/api/venues/free-soon?${coord(i)}&radius_km=20&days=3`, 1);
console.log('\nkesh holati:', JSON.stringify(cacheStatus()));

await VenueModel.deleteMany({ slug: /^bench-/ });
server.close();
await closeCache();
await disconnectDatabase();
