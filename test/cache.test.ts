// Kesh qatlami birlik testlari. TEST_REDIS_URL berilsa — haqiqiy Redis (L2) ham tekshiriladi.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/lokma_test';
if (process.env.TEST_REDIS_URL) process.env.REDIS_URL = process.env.TEST_REDIS_URL;

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';

const { cached, bump, initCache, closeCache, cacheStatus, clearL1ForTests } = await import('../src/infrastructure/cache.js');
await initCache();
const REDIS = cacheStatus().mode === 'redis';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uid = () => `t${Date.now()}${Math.random().toString(36).slice(2, 7)}`;

after(async () => { await closeCache(); });

describe(`kesh (${REDIS ? 'Redis + xotira' : 'xotira'})`, () => {
  test('birinchi so‘rov loader\'ni chaqiradi, keyingilari keshdan', async () => {
    let calls = 0;
    const name = uid();
    const load = async () => { calls++; return { n: calls }; };
    const a = await cached(name, 'x', { ttl: 30 }, load);
    const b = await cached(name, 'x', { ttl: 30 }, load);
    const c = await cached(name, 'y', { ttl: 30 }, load); // boshqa parametr — alohida kalit
    assert.equal(calls, 2);
    assert.deepEqual(a, { n: 1 });
    assert.deepEqual(b, { n: 1 });
    assert.deepEqual(c, { n: 2 });
  });

  test('muddati o‘tgach (swr yo‘q) qayta yuklanadi', async () => {
    let calls = 0;
    const name = uid();
    const load = async () => ++calls;
    await cached(name, '', { ttl: 0.15 }, load);
    await sleep(260);
    assert.equal(await cached(name, '', { ttl: 0.15 }, load), 2);
  });

  test('SWR: eskirgan qiymat DARHOL qaytadi, yangilash fonda', async () => {
    let calls = 0;
    const name = uid();
    const load = async () => { calls++; if (calls > 1) await sleep(300); return calls; };
    assert.equal(await cached(name, '', { ttl: 0.3, swr: 10 }, load), 1);
    await sleep(400);
    const t0 = Date.now();
    const stale = await cached(name, '', { ttl: 0.3, swr: 10 }, load);
    assert.equal(stale, 1, 'eski qiymat qaytdi');
    assert.ok(Date.now() - t0 < 100, `loader'ni kutmadi (${Date.now() - t0} ms)`);
    await sleep(500);
    assert.equal(await cached(name, '', { ttl: 0.3, swr: 10 }, load), 2, 'fonda yangilandi');
    assert.equal(calls, 2);
  });

  test('single-flight: 50 parallel so‘rov — loader bir marta', async () => {
    let calls = 0;
    const name = uid();
    const load = async () => { calls++; await sleep(80); return 'ok'; };
    const r = await Promise.all(Array.from({ length: 50 }, () => cached(name, '', { ttl: 30 }, load)));
    assert.equal(calls, 1);
    assert.ok(r.every((x) => x === 'ok'));
  });

  test('bump(venues) shu bog‘liqlikdagi keshni darhol eskirtiradi, slots ga tegmaydi', async () => {
    let v = 0, s = 0;
    const nv = uid(), ns = uid();
    const lv = async () => ++v, ls = async () => ++s;
    await cached(nv, '', { ttl: 60 }, lv, ['venues']);
    await cached(ns, '', { ttl: 60 }, ls, ['slots']);
    bump('venues');
    assert.equal(await cached(nv, '', { ttl: 60 }, lv, ['venues']), 2, 'venues keshi yangilandi');
    assert.equal(await cached(ns, '', { ttl: 60 }, ls, ['slots']), 1, 'slots keshi saqlandi');
    bump('slots');
    assert.equal(await cached(ns, '', { ttl: 60 }, ls, ['slots']), 2);
  });

  test('loader xatosi keshlanmaydi', async () => {
    let calls = 0;
    const name = uid();
    const load = async () => { calls++; if (calls === 1) throw new Error('baza uzildi'); return 'tuzaldi'; };
    await assert.rejects(cached(name, '', { ttl: 30 }, load), /baza uzildi/);
    assert.equal(await cached(name, '', { ttl: 30 }, load), 'tuzaldi');
  });

  test('murakkab qiymatlar (massiv, ichma-ich obyekt) saqlanadi', async () => {
    const name = uid();
    const data = [{ id: 'a', halls: [{ n: 1, tags: ['x', 'y'] }], at: null }];
    await cached(name, '', { ttl: 30 }, async () => data);
    if (REDIS) clearL1ForTests(); // Redis rejimida qiymat L2 (JSON) dan qaytadi
    assert.deepEqual(await cached(name, '', { ttl: 30 }, async () => { throw new Error('kesh ishlamadi'); }), data);
  });

  if (REDIS) {
    test('Redis: L1 tozalansa ham qiymat Redis\'dan keladi (loader chaqirilmaydi)', async () => {
      let calls = 0;
      const name = uid();
      const load = async () => ++calls;
      await cached(name, '', { ttl: 30 }, load);
      clearL1ForTests();
      assert.equal(await cached(name, '', { ttl: 30 }, load), 1);
      assert.equal(calls, 1);
      assert.ok(cacheStatus().l2 >= 1);
    });

    test('Redis: bump boshqa "instance" uchun ham ko‘rinadi (versiya Redis\'da)', async () => {
      let calls = 0;
      const name = uid();
      const load = async () => ++calls;
      await cached(name, '', { ttl: 60 }, load);
      bump('venues');
      await sleep(30); // INCR tugashi
      clearL1ForTests();
      assert.equal(await cached(name, '', { ttl: 60 }, load), 2);
    });
  }
});
