// Integratsion testlar: haqiqiy HTTP + MongoDB (TEST_MONGODB_URI).
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/lokma_test';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef';
process.env.TELEGRAM_BOT_TOKEN = '123456:TEST_BOT_TOKEN';
process.env.JWT_SECRET = 'test-secret-0123456789abcdef';
process.env.BOOKING_RATE_LIMIT = '1000';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const { createApp } = await import('../src/app.js');
const { connectDatabase, disconnectDatabase } = await import('../src/infrastructure/mongo.js');
const { seed } = await import('../src/scripts/seed.js');
const { SlotModel } = await import('../src/modules/slots/slot.model.js');
const { BookingModel } = await import('../src/modules/bookings/booking.model.js');
const { releaseExpiredHolds } = await import('../src/modules/slots/slot.service.js');
const { signInitData } = await import('../src/modules/auth/telegram.js');
const { todayISO, addDaysISO, isWeekendISO } = await import('../src/lib/dates.js');

const ADMIN = { 'x-admin-key': process.env.ADMIN_API_KEY! };
const AT = { lat: 41.2856, lng: 69.2034 }; // Chilonzor
let server: Server;
let base = '';

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const get = (p: string, h?: Record<string, string>) => call('GET', p, undefined, h);
const post = (p: string, b?: unknown, h?: Record<string, string>) => call('POST', p, b, h);

before(async () => {
  await connectDatabase();
  await SlotModel.syncIndexes();
  await seed({ fresh: true });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await disconnectDatabase();
});

// Yordamchi: to'yxona, zal, menyu va bron so'rovi
async function venueCtx(slug = 'navroz-saroyi') {
  const { body: v } = await get(`/api/venues/${slug}?lat=${AT.lat}&lng=${AT.lng}`);
  return v;
}
function bookingBody(v: any, date: string, session = 'evening', extra: Record<string, unknown> = {}) {
  return {
    venue_id: v.id, hall_id: v.halls[0].id, date, session, guests: 400,
    menu_package_id: v.menu_packages[1].id, vendor_ids: [],
    event_type: session === 'morning' ? 'nahorgi_osh' : session === 'day' ? 'kunduzgi' : 'kechki',
    customer_name: 'Aziz Karimov', customer_phone: '+998 90 123 45 67', ...extra,
  };
}

describe('health', () => {
  test('live va ready', async () => {
    assert.equal((await get('/api/health/live')).status, 200);
    const r = await get('/api/health/ready');
    assert.equal(r.status, 200);
    assert.equal(r.body.db, true);
  });
  test('noma’lum endpoint 404 JSON', async () => {
    const r = await get('/api/yoq');
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'not_found');
  });
});

describe('GET /api/venues', () => {
  test('radius bo‘yicha, masofa tartibida, to‘g‘ri shakl', async () => {
    const r = await get(`/api/venues?lat=${AT.lat}&lng=${AT.lng}&radius_km=20`);
    assert.equal(r.status, 200);
    assert.ok(r.body.length >= 5);
    for (let i = 1; i < r.body.length; i++) assert.ok(r.body[i - 1].distance_km <= r.body[i].distance_km);
    for (const v of r.body) assert.ok(v.distance_km <= 20);
    const first = r.body[0];
    assert.equal(first.slug, 'navroz-saroyi');
    assert.equal(first.distance_km, 0);
    assert.deepEqual(
      Object.keys(first).sort(),
      ['capacity_max', 'capacity_min', 'distance_km', 'district', 'has_parking', 'id', 'lat', 'lng', 'name', 'next_free', 'photos', 'photos_count', 'price_from', 'price_to', 'rating', 'reviews_count', 'slug'].sort(),
    );
    assert.equal(first.photos.length, 3);
    assert.equal(first.photos_count, 12);
    assert.equal(first.price_from, 90_000); // 150 000 × 0.6
    assert.ok(first.next_free.date >= todayISO());
  });

  test('50 km da ko‘proq, qidiruv va filtrlar', async () => {
    const r20 = await get(`/api/venues?lat=${AT.lat}&lng=${AT.lng}&radius_km=20`);
    const r50 = await get(`/api/venues?lat=${AT.lat}&lng=${AT.lng}&radius_km=50`);
    assert.ok(r50.body.length > r20.body.length);
    const q = await get(`/api/venues?lat=${AT.lat}&lng=${AT.lng}&radius_km=50&q=GUL`);
    assert.deepEqual(q.body.map((v: any) => v.slug), ['gulshan-hall']);
    const parking = await get(`/api/venues?lat=${AT.lat}&lng=${AT.lng}&radius_km=50&filter=parking`);
    assert.ok(parking.body.every((v: any) => v.has_parking));
    assert.ok(!parking.body.some((v: any) => v.slug === 'bahor-koshk'));
    const cheap = await get(`/api/venues?lat=${AT.lat}&lng=${AT.lng}&radius_km=50&filter=cheap&sort=price_asc`);
    assert.ok(cheap.body.every((v: any) => v.price_from <= 150000));
    for (let i = 1; i < cheap.body.length; i++) assert.ok(cheap.body[i - 1].price_from <= cheap.body[i].price_from);
    const morning = await get(`/api/venues?lat=${AT.lat}&lng=${AT.lng}&radius_km=50&event_type=nahorgi_osh`);
    assert.ok(morning.body.every((v: any) => v.next_free.session === 'morning'));
  });

  test('noto‘g‘ri parametr -> 422 o‘zbekcha xabar', async () => {
    const r = await get('/api/venues?lat=abc&lng=69');
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'validation');
    assert.match(r.body.message, /lat/);
  });

  test('free-soon: 3 kun ichida, ko‘pi bilan 6', async () => {
    const r = await get(`/api/venues/free-soon?lat=${AT.lat}&lng=${AT.lng}&radius_km=20&days=3`);
    assert.equal(r.status, 200);
    assert.ok(r.body.length > 0 && r.body.length <= 6);
    for (const it of r.body) {
      assert.ok(it.date >= todayISO() && it.date <= addDaysISO(todayISO(), 2));
      assert.ok(['morning', 'day', 'evening'].includes(it.session));
      assert.ok(it.venue.slug);
    }
  });
});

describe('to‘yxona sahifasi va kalendar', () => {
  test('detail shakli', async () => {
    const v = await venueCtx();
    assert.equal(v.photos.length, 12);
    assert.equal(v.halls.length, 2);
    assert.equal(v.sessions.length, 3);
    assert.equal(v.menu_packages.length, 3);
    assert.equal(v.vendors.length, 8);
    assert.equal(v.deposit_percent, 30);
    assert.equal(v.guests_max, 900);
    assert.match(v.halls[0].id, /^[a-f0-9]{24}$/);
  });

  test('topilmasa 404', async () => {
    const r = await get('/api/venues/yoq-toyxona');
    assert.equal(r.status, 404);
    assert.equal(r.body.message, 'To‘yxona topilmadi');
  });

  test('oylik kalendar: har kun 3 seans, o‘tgan kunlar closed', async () => {
    const v = await venueCtx();
    const month = todayISO().slice(0, 7);
    const r = await get(`/api/halls/${v.halls[0].id}/calendar?month=${month}`);
    assert.equal(r.status, 200);
    const [y, m] = month.split('-').map(Number);
    assert.equal(r.body.length, new Date(Date.UTC(y, m, 0)).getUTCDate());
    for (const d of r.body) {
      assert.deepEqual(Object.keys(d.sessions).sort(), ['day', 'evening', 'morning']);
      if (d.date < todayISO()) assert.equal(d.sessions.evening, 'closed');
    }
    assert.equal((await get(`/api/halls/${v.halls[0].id}/calendar?month=2026-13`)).status, 422);
    assert.equal((await get(`/api/halls/aaaaaaaaaaaaaaaaaaaaaaaa/calendar?month=${month}`)).status, 404);
  });
});

describe('narx (quote)', () => {
  test('formula ilova bilan bir xil', async () => {
    const v = await venueCtx();
    const date = addDaysISO(todayISO(), 20);
    const video = v.vendors.find((x: any) => x.name === 'Kadr Studio');
    const car = v.vendors.find((x: any) => x.name === 'Lincoln limuzin');
    const r = await post('/api/quote', { ...bookingBody(v, date), vendor_ids: [video.id, car.id] });
    assert.equal(r.status, 200);
    const k = isWeekendISO(date) ? 1.15 : 1;
    const ppg = Math.round((220000 * 1.15 * k) / 1000) * 1000;
    assert.equal(r.body.price_per_guest, ppg);
    assert.equal(r.body.venue_total, ppg * 400);
    assert.equal(r.body.total, ppg * 400 + 5_000_000 + 3_500_000);
    assert.equal(r.body.deposit, Math.round(r.body.total * 0.3));
    assert.equal(r.body.extras.length, 2);
  });

  test('qoidalar: mehmon soni, o‘tgan sana, bir turdagi 2 xizmat', async () => {
    const v = await venueCtx();
    const date = addDaysISO(todayISO(), 21);
    let r = await post('/api/quote', { ...bookingBody(v, date), guests: 50 });
    assert.equal(r.status, 422);
    assert.match(r.body.message, /Mehmonlar soni/);
    r = await post('/api/quote', { ...bookingBody(v, date), guests: 5000 });
    assert.equal(r.status, 422);
    r = await post('/api/quote', bookingBody(v, addDaysISO(todayISO(), -1)));
    assert.equal(r.status, 422);
    const videos = v.vendors.filter((x: any) => x.type === 'video').slice(0, 2).map((x: any) => x.id);
    r = await post('/api/quote', { ...bookingBody(v, date), vendor_ids: videos });
    assert.equal(r.status, 422);
  });
});

describe('bron', () => {
  test('yaratish -> hold, takror -> 409', async () => {
    const v = await venueCtx();
    const date = addDaysISO(todayISO(), 30);
    const r = await post('/api/bookings', bookingBody(v, date));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.number, /^TY-/);
    assert.equal(r.body.status, 'pending');
    assert.ok(new Date(r.body.hold_until).getTime() > Date.now() + 25 * 60_000);

    const cal = await get(`/api/halls/${v.halls[0].id}/calendar?month=${date.slice(0, 7)}`);
    assert.equal(cal.body.find((d: any) => d.date === date).sessions.evening, 'hold');

    const again = await post('/api/bookings', bookingBody(v, date, 'evening', { customer_name: 'Boshqa' }));
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'slot_taken');

    const other = await post('/api/bookings', { ...bookingBody(v, date), hall_id: v.halls[1].id, guests: 300 });
    assert.equal(other.status, 201, 'boshqa zal band qilinishi mumkin');
  });

  test('parallel 6 so‘rovdan faqat bittasi o‘tadi', async () => {
    const v = await venueCtx('gulshan-hall');
    const date = addDaysISO(todayISO(), 31);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => post('/api/bookings', bookingBody(v, date, 'day', { customer_name: `Mijoz ${i}`, guests: 300 }))),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 5);
    assert.equal(await BookingModel.countDocuments({ venue_id: v.id, date }), 1);
  });

  test('validatsiya: telefon, tadbir turi seansga mos emas', async () => {
    const v = await venueCtx();
    const date = addDaysISO(todayISO(), 32);
    let r = await post('/api/bookings', bookingBody(v, date, 'evening', { customer_phone: '12345' }));
    assert.equal(r.status, 422);
    r = await post('/api/bookings', bookingBody(v, date, 'evening', { event_type: 'nahorgi_osh' }));
    assert.equal(r.status, 422);
    assert.equal(await SlotModel.countDocuments({ date }), 0, 'xato bo‘lsa slot band bo‘lib qolmasligi kerak');
  });

  test('hold muddati tugasa: job bekor qiladi, seans bo‘shaydi', async () => {
    const v = await venueCtx();
    const date = addDaysISO(todayISO(), 33);
    const r = await post('/api/bookings', bookingBody(v, date));
    assert.equal(r.status, 201);
    await SlotModel.updateOne({ booking_id: r.body.id }, { $set: { hold_until: new Date(Date.now() - 1000) } });
    assert.equal(await releaseExpiredHolds(), 1);
    const b = await BookingModel.findById(r.body.id).lean();
    assert.equal(b!.status, 'cancelled');
    assert.equal(b!.cancel_reason, 'expired');
    const again = await post('/api/bookings', bookingBody(v, date));
    assert.equal(again.status, 201);
  });

  test('muddati o‘tgan hold’ni job ishlamasdan ham egallash mumkin', async () => {
    const v = await venueCtx();
    const date = addDaysISO(todayISO(), 34);
    const first = await post('/api/bookings', bookingBody(v, date));
    await SlotModel.updateOne({ booking_id: first.body.id }, { $set: { hold_until: new Date(Date.now() - 1000) } });
    const second = await post('/api/bookings', bookingBody(v, date, 'evening', { customer_name: 'Ikkinchi' }));
    assert.equal(second.status, 201);
    assert.equal((await BookingModel.findById(first.body.id).lean())!.status, 'cancelled');
  });
});

describe('admin', () => {
  test('kalitsiz 403', async () => {
    assert.equal((await get('/api/admin/bookings')).status, 403);
    assert.equal((await get('/api/admin/bookings', { 'x-admin-key': 'xato' })).status, 403);
  });

  test('tasdiqlash -> booked, bekor qilish -> bo‘sh', async () => {
    const v = await venueCtx();
    const date = addDaysISO(todayISO(), 40);
    const b = await post('/api/bookings', bookingBody(v, date));
    const c = await post(`/api/admin/bookings/${b.body.id}/confirm`, {}, ADMIN);
    assert.equal(c.status, 200);
    assert.equal(c.body.status, 'confirmed');
    const calUrl = `/api/halls/${v.halls[0].id}/calendar?month=${date.slice(0, 7)}`;
    assert.equal((await get(calUrl)).body.find((d: any) => d.date === date).sessions.evening, 'booked');
    assert.equal((await post(`/api/admin/bookings/${b.body.id}/confirm`, {}, ADMIN)).status, 409);
    const x = await post(`/api/admin/bookings/${b.body.id}/cancel`, { reason: 'mijoz rad etdi' }, ADMIN);
    assert.equal(x.body.status, 'cancelled');
    assert.equal((await get(calUrl)).body.find((d: any) => d.date === date).sessions.evening, 'free');
    const list = await get(`/api/admin/bookings?date=${date}`, ADMIN);
    assert.equal(list.body[0].customer_phone, '+998901234567');
  });

  test('seansni qo‘lda yopish va ochish', async () => {
    const v = await venueCtx();
    const date = addDaysISO(todayISO(), 41);
    const calUrl = `/api/halls/${v.halls[0].id}/calendar?month=${date.slice(0, 7)}`;
    let r = await call('PUT', '/api/admin/slots', { hall_id: v.halls[0].id, date, session: 'day', status: 'closed', note: 'ta’mir' }, ADMIN);
    assert.equal(r.status, 200);
    assert.equal((await get(calUrl)).body.find((d: any) => d.date === date).sessions.day, 'closed');
    assert.equal((await post('/api/bookings', bookingBody(v, date, 'day'))).status, 409);
    r = await call('PUT', '/api/admin/slots', { hall_id: v.halls[0].id, date, session: 'day', status: 'free' }, ADMIN);
    assert.equal((await get(calUrl)).body.find((d: any) => d.date === date).sessions.day, 'free');
  });
});

describe('Telegram auth va mening bronlarim', () => {
  const initData = (user: object, ageSec = 0) =>
    signInitData({ auth_date: String(Math.floor(Date.now() / 1000) - ageSec), query_id: 'AAH', user: JSON.stringify(user) }, process.env.TELEGRAM_BOT_TOKEN!);

  test('to‘g‘ri imzo -> token; soxta yoki eski -> 401', async () => {
    const ok = await post('/api/auth/telegram', { init_data: initData({ id: 777, first_name: 'Azim' }) });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    const tampered = initData({ id: 777, first_name: 'Azim' }).replace('Azim', 'Hacker');
    assert.equal((await post('/api/auth/telegram', { init_data: tampered })).status, 401);
    assert.equal((await post('/api/auth/telegram', { init_data: initData({ id: 777 }, 2 * 86400) })).status, 401);
  });

  test('o‘z bronlari ro‘yxati va bekor qilish', async () => {
    const { body } = await post('/api/auth/telegram', { init_data: initData({ id: 888, first_name: 'Dilnoza' }) });
    const auth = { authorization: `Bearer ${body.token}` };
    const v = await venueCtx();
    const date = addDaysISO(todayISO(), 50);
    const b = await post('/api/bookings', bookingBody(v, date), auth);
    assert.equal(b.status, 201);
    const mine = await get('/api/me/bookings', auth);
    assert.deepEqual(mine.body.map((x: any) => x.id), [b.body.id]);
    assert.equal((await get('/api/me/bookings')).status, 401);

    const other = await post('/api/auth/telegram', { init_data: initData({ id: 999 }) });
    assert.equal((await post(`/api/bookings/${b.body.id}/cancel`, {}, { authorization: `Bearer ${other.body.token}` })).status, 403);
    const c = await post(`/api/bookings/${b.body.id}/cancel`, {}, auth);
    assert.equal(c.body.status, 'cancelled');
    assert.equal((await get('/api/me/bookings', { authorization: 'Bearer xato.token' })).status, 401);
  });
});
