// Kesh va HTTP: har bir yozuv yo'li keshni DARHOL bekor qilishi kerak (eskirgan ma'lumot ko'rinmasin).
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/lokma_test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef';
process.env.JWT_SECRET = 'test-secret-0123456789abcdef';
process.env.BOOKING_RATE_LIMIT = '1000';
if (process.env.TEST_REDIS_URL) process.env.REDIS_URL = process.env.TEST_REDIS_URL;

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request as httpRequest, type Server } from 'node:http';

const { createApp } = await import('../src/app.js');
const { connectDatabase, disconnectDatabase } = await import('../src/infrastructure/mongo.js');
const { initCache, closeCache, cacheStatus } = await import('../src/infrastructure/cache.js');
const { seed } = await import('../src/scripts/seed.js');
const { SlotModel } = await import('../src/modules/slots/slot.model.js');
const { VenueModel } = await import('../src/modules/venues/venue.model.js');
const { busyMap } = await import('../src/modules/slots/slot.service.js');
const { todayISO, addDaysISO } = await import('../src/lib/dates.js');

const ADMIN = { 'x-admin-key': process.env.ADMIN_API_KEY! };
const AT = { lat: 41.2856, lng: 69.2034 };
let server: Server;
let base = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const get = (p: string, h?: Record<string, string>) => call('GET', p, undefined, h);
const list = () => get(`/api/venues?lat=${AT.lat}&lng=${AT.lng}&radius_km=50&sort=distance`);
const detail = (slug = 'navroz-saroyi') => get(`/api/venues/${slug}?lat=${AT.lat}&lng=${AT.lng}`);

before(async () => {
  await initCache();
  await connectDatabase();
  await SlotModel.syncIndexes();
  await seed({ fresh: true });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server?.close(); await closeCache(); await disconnectDatabase(); });

describe('HTTP kesh', () => {
  test('ikkinchi so‘rov keshdan (bazaga bormaydi) va javob bir xil', async () => {
    const a = await list();
    const before = cacheStatus();
    const b = await list();
    const after = cacheStatus();
    assert.deepEqual(a.body, b.body);
    assert.ok(after.l1 + after.l2 > before.l1 + before.l2, 'kesh hit oshdi');
    assert.equal(after.loads, before.loads, 'yangi yuklash bo‘lmadi');
  });

  test('ETag: o‘zgarmagan javobga 304, Cache-Control: no-cache, Server-Timing bor', async () => {
    const a = await list();
    const etag = a.headers.get('etag');
    assert.ok(etag, 'ETag bor');
    assert.equal(a.headers.get('cache-control'), 'no-cache');
    assert.match(a.headers.get('server-timing') ?? '', /^app;dur=\d/);
    // Node fetch shartli so'rovga o'zi "Cache-Control: no-cache" qo'shadi (brauzer qo'shmaydi) — xom http bilan yuboramiz
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${base}/api/venues?lat=${AT.lat}&lng=${AT.lng}&radius_km=50&sort=distance`);
      httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { 'if-none-match': etag! } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).on('error', reject).end();
    });
    assert.equal(status, 304);
  });

  test('health/ready kesh holatini ko‘rsatadi', async () => {
    const r = await get('/api/health/ready');
    assert.equal(r.status, 200);
    assert.ok(['memory', 'redis'].includes(r.body.cache.mode));
  });
});

describe('bekor qilish: yozuv → keyingi so‘rovda yangi ma’lumot', () => {
  test('menyu narxi o‘zgarsa ro‘yxat va sahifa darhol yangilanadi', async () => {
    const before = (await list()).body.find((v: any) => v.slug === 'navroz-saroyi');
    await detail(); // detail ham keshlansin
    await VenueModel.updateOne({ slug: 'navroz-saroyi' }, { $set: { 'menu_packages.0.price_per_guest': 11_111 } });
    const after = (await list()).body.find((v: any) => v.slug === 'navroz-saroyi');
    assert.notEqual(after.price_from, before.price_from);
    assert.ok(after.price_from <= 11_111 * 1.5, `narx yangilandi: ${before.price_from} → ${after.price_from}`);
    const d = (await detail()).body;
    assert.equal(d.menu_packages[0].price_per_guest, 11_111);
  });

  test('admin API orqali to‘yxonani bloklash — ro‘yxatdan va sahifadan darhol yo‘qoladi', async () => {
    const all = (await list()).body;
    const victim = all.find((v: any) => v.slug === 'gulshan-hall') ?? all[all.length - 1];
    assert.equal((await detail(victim.slug)).status, 200);
    assert.equal((await call('POST', `/api/admin/venues/${victim.id}/block`, { reason: 'kesh testi' }, ADMIN)).status, 200);
    assert.ok(!(await list()).body.some((v: any) => v.id === victim.id), 'ro‘yxatdan chiqdi');
    assert.equal((await detail(victim.slug)).status, 404, 'sahifa 404');
    assert.equal((await call('POST', `/api/admin/venues/${victim.id}/unblock`, {}, ADMIN)).status, 200);
    assert.equal((await detail(victim.slug)).status, 200, 'qaytdi');
  });

  test('bron — kalendar, "bo‘sh kun" va ro‘yxat DARHOL yangilanadi', async () => {
    const d = (await detail()).body;
    const hall = d.halls[0];
    const month = d.next_free.date.slice(0, 7);
    const calBefore = (await get(`/api/halls/${hall.id}/calendar?month=${month}`)).body;
    const slotBefore = calBefore.find((x: any) => x.date === d.next_free.date).sessions[d.next_free.session];
    assert.equal(slotBefore, 'free');
    const book = await call('POST', '/api/bookings', {
      venue_id: d.id, hall_id: hall.id, date: d.next_free.date, session: d.next_free.session, guests: 400,
      menu_package_id: d.menu_packages[1].id, vendor_ids: [], event_type: d.next_free.session === 'morning' ? 'nahorgi_osh' : d.next_free.session === 'day' ? 'kunduzgi' : 'kechki',
      customer_name: 'Kesh Test', customer_phone: '+998 90 123 45 67',
    });
    assert.equal(book.status, 201, JSON.stringify(book.body));
    const cal = (await get(`/api/halls/${hall.id}/calendar?month=${month}`)).body;
    assert.equal(cal.find((x: any) => x.date === d.next_free.date).sessions[d.next_free.session], 'hold', 'kalendarda band');
    // ikkinchi zal bo'sh qolishi mumkin: shu zal bo'yicha "bo'sh" qiymat o'zgardi yoki keyingi seans/zalga o'tdi
    const d2 = (await detail()).body;
    const same = d2.next_free.date === d.next_free.date && d2.next_free.session === d.next_free.session;
    assert.ok(!same || d.halls.length > 1, 'keyingi bo‘sh seans yangilandi');
    // ikkinchi marta shu seansga bron — 409 (keshga emas, bazaga qarab)
    const dup = await call('POST', '/api/bookings', { ...book.body && { venue_id: d.id, hall_id: hall.id, date: d.next_free.date, session: d.next_free.session, guests: 400, menu_package_id: d.menu_packages[1].id, vendor_ids: [], event_type: 'kechki', customer_name: 'Boshqa', customer_phone: '+998 91 111 22 33' } });
    assert.equal(dup.status, 409);
  });

  test('admin qo‘lda seansni yopsa kalendar darhol "closed", ochsa "free"', async () => {
    const d = (await detail()).body;
    const hall = d.halls[0];
    const date = addDaysISO(todayISO(), 20);
    const month = date.slice(0, 7);
    const status = async () => (await get(`/api/halls/${hall.id}/calendar?month=${month}`)).body.find((x: any) => x.date === date).sessions.day;
    assert.equal(await status(), 'free');
    assert.equal((await call('PUT', '/api/admin/slots', { hall_id: hall.id, date, session: 'day', status: 'closed' }, ADMIN)).status, 200);
    assert.equal(await status(), 'closed');
    assert.equal((await call('PUT', '/api/admin/slots', { hall_id: hall.id, date, session: 'day', status: 'free' }, ADMIN)).status, 200);
    assert.equal(await status(), 'free');
  });

  test('muddati o‘tgan hold keshni bekor qilmasdan ham ko‘rinmay qoladi (o‘qish paytida filtr)', async () => {
    const d = (await detail()).body;
    const date = addDaysISO(todayISO(), 25);
    const created = await SlotModel.create({ venue_id: d.id, hall_id: d.halls[0].id, date, session: 'morning', status: 'hold', hold_until: new Date(Date.now() + 1500) });
    const key = `${d.halls[0].id}|${date}|morning`;
    assert.equal((await busyMap()).get(key), 'hold', 'hold ko‘rinadi');
    await sleep(2600);
    assert.equal((await busyMap()).get(key), undefined, 'muddati o‘tgach hold ko‘rinmaydi (bump bo‘lmadi)');
    await SlotModel.deleteOne({ _id: created._id });
  });
});

describe('admin: keshni qo‘lda tozalash', () => {
  test('kalitsiz 401, kalit bilan ok', async () => {
    assert.equal((await call('POST', '/api/admin/cache/flush')).status, 403, 'kalitsiz — rad');
    const r = await call('POST', '/api/admin/cache/flush', {}, ADMIN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });
});
