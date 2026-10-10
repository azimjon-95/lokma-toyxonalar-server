// Egasi/xodim mobil ilovasi API testlari: haqiqiy HTTP + MongoDB.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/lokma_test_owner';
process.env.ADMIN_API_KEY = 'test-admin-key-0123456789abcdef';
process.env.JWT_SECRET = 'test-secret-0123456789abcdef';
process.env.BOOKING_RATE_LIMIT = '1000';
process.env.CLOUDINARY_CLOUD_NAME = 'demo-cloud';
process.env.CLOUDINARY_API_KEY = '123456789012345';
process.env.CLOUDINARY_API_SECRET = 'test-cloudinary-secret';
process.env.CLOUDINARY_VERIFY = 'true';

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const { createApp } = await import('../src/app.js');
const { connectDatabase, disconnectDatabase } = await import('../src/infrastructure/mongo.js');
const { seed, DEMO } = await import('../src/scripts/seed.js');
const { SlotModel } = await import('../src/modules/slots/slot.model.js');
const { ReservationModel } = await import('../src/modules/owner/owner.models.js');
const { DishModel } = await import('../src/modules/owner-app/owner-app.models.js');
const { addDaysISO, todayISO } = await import('../src/lib/dates.js');
const { setCloudinaryFetch, signParams, createUploadTicket, requireCloudinary, resizeUrl, imageUrl, assertOwnedPublicId, destroyAsset } = await import('../src/modules/cloudinary/cloudinary.service.js');
const { setSmsFetch } = await import('../src/modules/owner-app/sms.service.js');
const jwt = (await import('jsonwebtoken')).default;

const ADMIN = { 'x-admin-key': process.env.ADMIN_API_KEY! };
const API = '/api/owner-app';
let server: Server;
let base = '';

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const get = (p: string, h?: Record<string, string>) => call('GET', p, undefined, h);
const post = (p: string, b?: unknown, h?: Record<string, string>) => call('POST', p, b, h);
const patch = (p: string, b?: unknown, h?: Record<string, string>) => call('PATCH', p, b, h);
const put = (p: string, b?: unknown, h?: Record<string, string>) => call('PUT', p, b, h);
const del = (p: string, h?: Record<string, string>) => call('DELETE', p, undefined, h);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** Telefon+parol → rol tokeni */
async function signIn(phone: string, password: string, role?: string) {
  const l = await post(`${API}/auth/login`, { phone, password });
  assert.equal(l.status, 200, JSON.stringify(l.body));
  const s = await get(`${API}/auth/session${role ? `?role=${role}` : ''}`, bearer(l.body.token));
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return { token: s.body.token as string, user: s.body.user, roles: l.body.roles as string[] };
}

let owner: Awaited<ReturnType<typeof signIn>>;
let staff: Awaited<ReturnType<typeof signIn>>;
let O: Record<string, string>; // egasi sarlavhasi
let S: Record<string, string>; // xodim sarlavhasi
let me: any;
let hall0: string; let hall1: string; let menuId: string;
let day = 30;
const nextDate = () => addDaysISO(todayISO(), day++);

// Cloudinary soxta HTTP
const cloudCalls: { url: string; body?: string }[] = [];
setCloudinaryFetch(async (url, init) => {
  cloudCalls.push({ url, body: init?.body ? String(init.body) : undefined });
  if (url.includes('/resources/image/upload/')) {
    if (url.includes('missing')) return new Response('{}', { status: 404 });
    const public_id = url.split('/resources/image/upload/')[1];
    return new Response(JSON.stringify({ public_id, version: 1700000000, width: 1600, height: 1067, bytes: 210000, format: 'jpg' }), { status: 200 });
  }
  if (url.includes('/image/destroy')) return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
  return new Response('{}', { status: 404 });
});

before(async () => {
  await connectDatabase();
  await SlotModel.syncIndexes();
  await ReservationModel.syncIndexes();
  await DishModel.syncIndexes();
  await seed({ fresh: true });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  owner = await signIn(DEMO.owner.phone, DEMO.owner.password, 'owner');
  staff = await signIn(DEMO.staff.phone, DEMO.staff.password);
  O = bearer(owner.token); S = bearer(staff.token);
  me = (await get(`${API}/me`, O)).body;
  hall0 = me.venue.halls[0].id; hall1 = me.venue.halls[1].id;
  menuId = (await get(`${API}/menus`, O)).body[1].id;
});
after(async () => { server?.close(); await disconnectDatabase(); });

const newBooking = (over: Record<string, unknown> = {}) => ({
  hall_id: hall0, date: nextDate(), session: 'evening', event_type: 'kechki', customer_name: 'Test Mijoz', customer_phone: '+998 90 111 22 33',
  guests: 300, menu_id: menuId, total: 50_000_000, stage: 'pending', ...over,
});

describe('autentifikatsiya', () => {
  test('login: xato parol 401 (bir xil xabar), to‘g‘ri — token va rollar', async () => {
    const bad = await post(`${API}/auth/login`, { phone: DEMO.owner.phone, password: 'xato-parol' });
    const none = await post(`${API}/auth/login`, { phone: '+998900000000', password: 'xato-parol' });
    assert.equal(bad.status, 401);
    assert.equal(none.status, 401);
    assert.equal(bad.body.message, none.body.message, 'telefon mavjudligi oshkor bo‘lmasin');
    assert.equal((await post(`${API}/auth/login`, { phone: '123', password: 'x' })).status, 422);
    assert.deepEqual(owner.roles, ['owner']);
    assert.equal(owner.user.role, 'owner');
    assert.equal(owner.user.venue_name, 'Navro‘z Saroyi');
    assert.equal(staff.user.role, 'staff');
    const spaced = await post(`${API}/auth/login`, { phone: '90 123 45 67', password: DEMO.owner.password });
    assert.equal(spaced.status, 200, 'telefon formati erkin');
  });

  test('begona tokenlar ishlamaydi: Telegram tokeni, login tokeni, tokensiz', async () => {
    const tg = jwt.sign({ sub: 'x', tg: 1 }, process.env.JWT_SECRET!);
    assert.equal((await get(`${API}/me`, bearer(tg))).status, 401);
    const l = await post(`${API}/auth/login`, { phone: DEMO.owner.phone, password: DEMO.owner.password });
    assert.equal((await get(`${API}/me`, bearer(l.body.token))).status, 401, 'login tokeni API uchun emas');
    assert.equal((await get(`${API}/me`)).status, 401);
    assert.equal((await get(`${API}/bookings`, ADMIN)).status, 401, 'admin kaliti ilova API’sini ochmaydi');
    // sessiya tekshiruvi (ilova ochilganda)
    const s = await get(`${API}/auth/session`, O);
    assert.equal(s.status, 200);
    assert.equal(s.body.user.role, 'owner');
  });

  test('/me: to‘yxona, zallar, seanslar, ruxsatlar', async () => {
    assert.equal(me.venue.halls.length, 2);
    assert.ok(me.venue.sessions.some((s: any) => s.code === 'evening' && s.start_time === '18:00'));
    assert.equal(me.permissions.money, true);
    assert.ok(me.event_types.some((e: any) => e.code === 'nikoh'));
    assert.equal(me.venue.subscription.state, 'free');
    const sm = (await get(`${API}/me`, S)).body;
    assert.equal(sm.permissions.money, false);
    assert.equal(sm.permissions.manage_menu, false);
  });

  test('parolni tiklash: SMS kod, noto‘g‘ri urinishlar, eski token bekor', async () => {
    const t = await signIn(DEMO.staff.phone, DEMO.staff.password);
    const unknown = await post(`${API}/auth/forgot`, { phone: '+998900000001' });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.dev_code, undefined, 'mavjud bo‘lmagan raqamga kod yaratilmaydi, lekin javob bir xil');
    const f = await post(`${API}/auth/forgot`, { phone: DEMO.staff.phone });
    assert.equal(f.status, 200);
    assert.match(f.body.dev_code, /^\d{6}$/);
    assert.equal((await post(`${API}/auth/reset`, { phone: DEMO.staff.phone, code: '000000', password: 'yangi-parol1' })).status, 400);
    assert.equal((await post(`${API}/auth/reset`, { phone: DEMO.staff.phone, code: f.body.dev_code, password: '123' })).status, 422, 'qisqa parol');
    const ok = await post(`${API}/auth/reset`, { phone: DEMO.staff.phone, code: f.body.dev_code, password: 'yangi-parol1' });
    assert.equal(ok.status, 200);
    assert.equal((await get(`${API}/me`, bearer(t.token))).status, 401, 'eski sessiya bekor');
    assert.equal((await post(`${API}/auth/login`, { phone: DEMO.staff.phone, password: DEMO.staff.password })).status, 401);
    assert.equal((await post(`${API}/auth/reset`, { phone: DEMO.staff.phone, code: f.body.dev_code, password: 'yangi-parol2' })).status, 400, 'kod bir marta');
    staff = await signIn(DEMO.staff.phone, 'yangi-parol1'); S = bearer(staff.token);
  });

  test('5 ta noto‘g‘ri urinishdan keyin kod bekor qilinadi', async () => {
    const f = await post(`${API}/auth/forgot`, { phone: DEMO.staff.phone });
    for (let i = 0; i < 5; i++) assert.equal((await post(`${API}/auth/reset`, { phone: DEMO.staff.phone, code: '111111', password: 'abcdef1' })).status, 400);
    const r = await post(`${API}/auth/reset`, { phone: DEMO.staff.phone, code: f.body.dev_code, password: 'abcdef1' });
    assert.equal(r.status, 429);
  });

  test('bloklangan to‘yxona: login 403, mavjud token ham darhol yopiladi', async () => {
    const venueId = me.venue.id;
    assert.equal((await post(`/api/admin/venues/${venueId}/block`, { reason: 'Obuna to‘lanmagan' }, ADMIN)).status, 200);
    const l = await post(`${API}/auth/login`, { phone: DEMO.owner.phone, password: DEMO.owner.password });
    assert.equal(l.status, 403);
    assert.match(l.body.message, /Obuna to‘lanmagan/);
    assert.equal((await get(`${API}/bookings`, O)).status, 403);
    assert.equal((await post(`/api/admin/venues/${venueId}/unblock`, {}, ADMIN)).status, 200);
    assert.equal((await get(`${API}/bookings`, O)).status, 200);
  });
});

describe('bronlar: egasi', () => {
  test('yaratish -> pending, seans band, mijoz ilovasida ham band', async () => {
    const body = newBooking();
    const r = await post(`${API}/bookings`, body, O);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const b = r.body;
    assert.equal(b.source, 'owner');
    assert.equal(b.status, 'pending');
    assert.equal(b.start_time, '18:00'); assert.equal(b.end_time, '23:00');
    assert.equal(b.customer_phone, '+998901112233', 'telefon normallashadi');
    assert.equal(b.total, 50_000_000); assert.equal(b.balance, 50_000_000); assert.deepEqual(b.payments, []);
    assert.equal(b.hall_name, 'Katta zal');
    const cal = await get(`/api/halls/${hall0}/calendar?month=${body.date.slice(0, 7)}`);
    assert.equal(cal.body.find((d: any) => d.date === body.date).sessions.evening, 'booked');
    // mijoz ilovasi shu seansni bron qila olmaydi
    const cust = await post('/api/bookings', { venue_id: me.venue.id, hall_id: hall0, date: body.date, session: 'evening', guests: 300, menu_package_id: menuId, vendor_ids: [], event_type: 'kechki', customer_name: 'Mijoz', customer_phone: '+998 90 555 66 77' });
    assert.equal(cust.status, 409);
    assert.equal(cust.body.code, 'slot_taken');
    // egasi ikkinchi marta ham ololmaydi
    const dup = await post(`${API}/bookings`, body, O);
    assert.equal(dup.status, 409);
  });

  test('validatsiya: o‘tgan sana, noto‘g‘ri telefon, seansga mos bo‘lmagan tadbir, noma’lum zal', async () => {
    assert.equal((await post(`${API}/bookings`, newBooking({ date: addDaysISO(todayISO(), -1) }), O)).status, 422);
    assert.equal((await post(`${API}/bookings`, newBooking({ customer_phone: '123' }), O)).status, 422);
    assert.equal((await post(`${API}/bookings`, newBooking({ event_type: 'nahorgi_osh' }), O)).status, 422, 'kechki seansda nahorgi osh emas');
    assert.equal((await post(`${API}/bookings`, newBooking({ hall_id: 'aaaaaaaaaaaaaaaaaaaaaaaa' }), O)).status, 404);
    assert.equal((await post(`${API}/bookings`, newBooking({ total: 0 }), O)).status, 422);
    assert.equal((await post(`${API}/bookings`, newBooking({ customer_name: 'A' }), O)).status, 422);
  });

  test('to‘lovlar: zakalat -> tasdiqlangan, qoldiq, ortiqcha to‘lov rad, qaytarish', async () => {
    const b = (await post(`${API}/bookings`, newBooking(), O)).body;
    let r = await post(`${API}/bookings/${b.id}/payments`, { kind: 'deposit', amount: 10_000_000, method: 'card' }, O);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'confirmed', 'birinchi to‘lovdan keyin avtomatik tasdiqlanadi');
    assert.equal(r.body.deposit_paid, 10_000_000); assert.equal(r.body.paid, 10_000_000); assert.equal(r.body.balance, 40_000_000);
    assert.equal(r.body.payments[0].method, 'card');
    const over = await post(`${API}/bookings/${b.id}/payments`, { kind: 'payment', amount: 40_000_001, method: 'cash' }, O);
    assert.equal(over.status, 422); assert.match(over.body.message, /Qoldiqdan oshmasin/);
    r = await post(`${API}/bookings/${b.id}/payments`, { kind: 'payment', amount: 40_000_000, method: 'transfer' }, O);
    assert.equal(r.body.balance, 0);
    assert.equal((await post(`${API}/bookings/${b.id}/payments`, { kind: 'refund', amount: 60_000_000, method: 'cash' }, O)).status, 422);
    r = await post(`${API}/bookings/${b.id}/payments`, { kind: 'refund', amount: 1_000_000, method: 'cash' }, O);
    assert.equal(r.body.paid, 49_000_000); assert.equal(r.body.balance, 1_000_000);
    assert.equal(r.body.payments.length, 3);
  });

  test('holatlar: yakunlash, yakunlanganga to‘lov yozib bo‘lmaydi', async () => {
    const b = (await post(`${API}/bookings`, newBooking({ stage: 'deposit' }), O)).body;
    assert.equal(b.status, 'deposit');
    let r = await post(`${API}/bookings/${b.id}/status`, { status: 'confirmed' }, O);
    assert.equal(r.body.status, 'confirmed');
    r = await post(`${API}/bookings/${b.id}/status`, { status: 'completed' }, O);
    assert.equal(r.body.status, 'completed');
    assert.equal((await post(`${API}/bookings/${b.id}/payments`, { kind: 'deposit', amount: 1000, method: 'cash' }, O)).status, 409);
    assert.equal((await patch(`${API}/bookings/${b.id}`, { guests: 10 }, O)).status, 409, 'yakunlangan bron tahrirlanmaydi');
  });

  test('bekor qilish: arxivga o‘tadi, seans bo‘shaydi, qayta band qilish mumkin, tarixda qoladi', async () => {
    const date = nextDate();
    const b = (await post(`${API}/bookings`, newBooking({ date }), O)).body;
    await post(`${API}/bookings/${b.id}/payments`, { kind: 'deposit', amount: 5_000_000, method: 'cash' }, O);
    const c = await post(`${API}/bookings/${b.id}/status`, { status: 'cancelled' }, O);
    assert.equal(c.status, 200); assert.equal(c.body.status, 'cancelled');
    const cal = await get(`/api/halls/${hall0}/calendar?month=${date.slice(0, 7)}`);
    assert.equal(cal.body.find((d: any) => d.date === date).sessions.evening, 'free');
    const again = await post(`${API}/bookings`, newBooking({ date, customer_name: 'Yangi Mijoz' }), O);
    assert.equal(again.status, 201, 'bekor qilingan seansga yangi bron');
    const one = await get(`${API}/bookings/${b.id}`, O);
    assert.equal(one.body.status, 'cancelled');
    assert.equal(one.body.paid, 5_000_000, 'olingan pul tarixda saqlanadi');
    const list = (await get(`${API}/bookings?from=${date}&to=${date}`, O)).body;
    assert.deepEqual(list.map((x: any) => x.status).sort(), ['cancelled', 'pending']);
    assert.equal((await post(`${API}/bookings/${b.id}/status`, { status: 'confirmed' }, O)).status, 409);
    assert.equal((await post(`${API}/bookings/${b.id}/payments`, { kind: 'deposit', amount: 1000, method: 'cash' }, O)).status, 409);
  });

  test('tahrirlash: seans ko‘chadi (eski bo‘shaydi), band joyga ko‘chirib bo‘lmaydi', async () => {
    const d1 = nextDate(); const d2 = nextDate();
    const a = (await post(`${API}/bookings`, newBooking({ date: d1 }), O)).body;
    const blocker = (await post(`${API}/bookings`, newBooking({ date: d2 }), O)).body;
    const clash = await patch(`${API}/bookings/${a.id}`, { date: d2 }, O);
    assert.equal(clash.status, 409);
    assert.equal((await get(`${API}/bookings/${a.id}`, O)).body.date, d1, 'o‘zgarish bo‘lmadi');
    const d3 = nextDate();
    const moved = await patch(`${API}/bookings/${a.id}`, { date: d3, hall_id: hall1, guests: 120, notes: 'Ko‘chirildi', customer_name: 'Yangi Ism' }, O);
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.date, d3); assert.equal(moved.body.hall_name, 'Kichik zal'); assert.equal(moved.body.guests, 120);
    assert.equal(moved.body.notes, 'Ko‘chirildi'); assert.equal(moved.body.customer_name, 'Yangi Ism');
    const cal1 = await get(`/api/halls/${hall0}/calendar?month=${d1.slice(0, 7)}`);
    assert.equal(cal1.body.find((d: any) => d.date === d1).sessions.evening, 'free');
    const cal3 = await get(`/api/halls/${hall1}/calendar?month=${d3.slice(0, 7)}`);
    assert.equal(cal3.body.find((d: any) => d.date === d3).sessions.evening, 'booked');
    void blocker;
  });

  test('narx taklifi mijoz ilovasi bilan bir xil; bandlik va ishchi biriktirish', async () => {
    const date = nextDate();
    const q = await post(`${API}/bookings/quote`, { hall_id: hall0, date, session: 'evening', guests: 300, menu_id: menuId }, O);
    const cust = await post('/api/quote', { venue_id: me.venue.id, hall_id: hall0, date, session: 'evening', guests: 300, menu_package_id: menuId, vendor_ids: [] });
    assert.equal(q.body.price_per_guest, cust.body.price_per_guest);
    assert.equal(q.body.total, cust.body.venue_total);
    assert.equal(q.body.deposit_suggested, cust.body.deposit);
    const q2 = await post(`${API}/bookings/quote`, { hall_id: hall0, date, session: 'evening', guests: 900, menu_id: menuId }, O);
    assert.equal(q2.body.warnings.length, 0);
    const q3 = await post(`${API}/bookings/quote`, { hall_id: hall1, date, session: 'evening', guests: 900, menu_id: menuId }, O);
    assert.ok(q3.body.warnings[0].includes('sig‘imi'), 'zal sig‘imi haqida ogohlantirish');

    const b = (await post(`${API}/bookings`, newBooking({ date }), O)).body;
    const av = (await get(`${API}/bookings/availability?date=${date}`, O)).body;
    const ev = av.halls.find((h: any) => h.hall_id === hall0).sessions.find((s: any) => s.code === 'evening');
    assert.equal(ev.state, 'booked'); assert.equal(ev.who, 'Test Mijoz');
    assert.equal(av.halls.find((h: any) => h.hall_id === hall1).sessions.find((s: any) => s.code === 'evening').state, 'free');

    const emps = (await get(`${API}/employees`, O)).body;
    const asg = await put(`${API}/bookings/${b.id}/staff`, { employee_ids: [emps[0].id, emps[1].id] }, O);
    assert.equal(asg.status, 200); assert.equal(asg.body.staff_ids.length, 2);
    assert.equal((await put(`${API}/bookings/${b.id}/staff`, { employee_ids: ['aaaaaaaaaaaaaaaaaaaaaaaa'] }, O)).status, 404);
    const after = (await get(`${API}/employees`, O)).body.find((e: any) => e.id === emps[0].id);
    assert.ok(after.events_count >= 1);
  });
});

describe('Lokma ilovasi orqali kelgan bronlar (egasi ilovasida)', () => {
  const placeAppBooking = async (date: string, session = 'evening', guests = 300) => {
    const r = await post('/api/bookings', { venue_id: me.venue.id, hall_id: hall1, date, session, guests, menu_package_id: menuId, vendor_ids: [], event_type: session === 'morning' ? 'nahorgi_osh' : 'kechki', customer_name: 'Lokma Mijoz', customer_phone: '+998 93 777 88 99' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };

  test('ro‘yxatda bir xil shaklda ko‘rinadi; tasdiqlash seansni band qiladi; to‘lov qoldiqni yopadi', async () => {
    const date = nextDate();
    const app = await placeAppBooking(date, 'evening', 200);
    const list = (await get(`${API}/bookings?from=${date}&to=${date}`, O)).body;
    const x = list.find((b: any) => b.number === app.number);
    assert.ok(x, 'ilova broni ro‘yxatda');
    assert.equal(x.source, 'app'); assert.equal(x.status, 'pending'); assert.equal(x.total, app.total);
    assert.ok(x.hold_until);
    assert.equal(x.customer_phone, '+998937778899', 'telefon bir xil formatda');
    // Mijoz ilovasi bilan bir xil maydonlar, egasi uchun qo‘shimchalar bilan
    for (const k of ['id', 'status', 'date', 'session', 'start_time', 'end_time', 'hall_name', 'guests', 'customer_name', 'menu_name', 'staff_ids', 'created_at', 'balance', 'payments']) assert.ok(k in x, `${k} yo‘q`);

    const conf = await post(`${API}/bookings/${x.id}/status`, { status: 'confirmed' }, O);
    assert.equal(conf.body.status, 'confirmed');
    assert.equal(conf.body.hold_until, null);
    assert.equal(conf.body.deposit_paid, app.deposit, 'tasdiqlangan ilova avansi to‘langan hisoblanadi');
    const cal = await get(`/api/halls/${hall1}/calendar?month=${date.slice(0, 7)}`);
    assert.equal(cal.body.find((d: any) => d.date === date).sessions.evening, 'booked');

    const rest = app.total - app.deposit;
    const pay = await post(`${API}/bookings/${x.id}/payments`, { kind: 'payment', amount: rest, method: 'cash' }, O);
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.equal(pay.body.balance, 0); assert.equal(pay.body.paid, app.total); assert.equal(pay.body.payments.length, 2);
    assert.equal((await post(`${API}/bookings/${x.id}/status`, { status: 'pending' }, O)).status, 409, 'ilova broni "Yangi"ga qaytmaydi');
    assert.equal((await patch(`${API}/bookings/${x.id}`, { guests: 10 }, O)).status, 409, 'mijoz buyurtmasi o‘zgarmaydi');
    const note = await patch(`${API}/bookings/${x.id}`, { notes: 'Gul bezagi so‘raldi' }, O);
    assert.equal(note.body.notes, 'Gul bezagi so‘raldi');
  });

  test('birinchi to‘lov kutilayotgan ilova bronini tasdiqlaydi; bekor qilish seansni bo‘shatadi', async () => {
    const date = nextDate();
    const app = await placeAppBooking(date, 'evening', 200);
    const pay = await post(`${API}/bookings/${app.id}/payments`, { kind: 'deposit', amount: app.deposit, method: 'click' }, O);
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.equal(pay.body.status, 'confirmed');
    assert.equal(pay.body.payments.length, 1);
    const cx = await post(`${API}/bookings/${app.id}/status`, { status: 'cancelled' }, O);
    assert.equal(cx.body.status, 'cancelled');
    const cal = await get(`/api/halls/${hall1}/calendar?month=${date.slice(0, 7)}`);
    assert.equal(cal.body.find((d: any) => d.date === date).sessions.evening, 'free');
  });

  test('boshqa to‘yxona bronlarini ko‘rib bo‘lmaydi (alohida egasi)', async () => {
    const other = (await get('/api/venues?lat=41.2995&lng=69.2401&radius_km=5&q=Oltin')).body[0];
    assert.equal(other.slug, 'oltin-qasr');
    const acc = await put(`/api/admin/venues/${other.id}/account`, { login: 'oltin', password: 'oltin123', phone: '90 777 00 01', name: 'Oltin egasi' }, ADMIN);
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    assert.equal(acc.body.phone, '+998907770001');
    const dupPhone = await put(`/api/admin/venues/${me.venue.id}/account`, { login: 'navroz', phone: '+998907770001' }, ADMIN);
    assert.equal(dupPhone.status, 409, 'telefon bitta hisobga');
    const o2 = await signIn('+998907770001', 'oltin123');
    const mine = (await get(`${API}/bookings`, bearer(o2.token))).body;
    assert.ok(mine.every((b: any) => b.hall_name), 'ro‘yxat bor');
    const first = (await get(`${API}/bookings?limit=1`, O)).body[0];
    assert.equal((await get(`${API}/bookings/${first.id}`, bearer(o2.token))).status, 404, 'begona bron — 404');
    assert.equal((await post(`${API}/bookings/${first.id}/status`, { status: 'cancelled' }, bearer(o2.token))).status, 404);
    assert.equal((await get(`${API}/me`, bearer(o2.token))).body.venue.name, 'Oltin Qasr');
  });
});

describe('xodim roli: pulni ko‘rmaydi', () => {
  test('bronlarda pul maydonlari yo‘q; yaratish mumkin; tahrir/to‘lov/holat/moliya/menyu/rasm — 403', async () => {
    const list = (await get(`${API}/bookings`, S)).body;
    assert.ok(list.length > 0);
    for (const b of list) for (const k of ['total', 'paid', 'balance', 'payments', 'deposit_paid', 'price_per_guest', 'pricing_mode']) assert.ok(!(k in b), `xodimga ${k} yuborilmasin`);
    const made = await post(`${API}/bookings`, newBooking({ customer_name: 'Xodim yaratdi' }), S);
    assert.equal(made.status, 201);
    assert.ok(!('total' in made.body));
    const id = made.body.id;
    for (const [m, p, b] of [
      ['patch', `${API}/bookings/${id}`, { guests: 5 }], ['post', `${API}/bookings/${id}/status`, { status: 'confirmed' }],
      ['post', `${API}/bookings/${id}/payments`, { kind: 'deposit', amount: 1000, method: 'cash' }], ['put', `${API}/bookings/${id}/staff`, { employee_ids: [] }],
      ['get', `${API}/finance/overview`, undefined], ['get', `${API}/finance/operations`, undefined],
      ['post', `${API}/transactions`, { type: 'expense', category: 'kommunal', amount: 1000 }],
      ['post', `${API}/menus`, { name: 'X menyu', price_per_person: 1000, dishes: ['a b'] }], ['post', `${API}/dishes`, { name: 'Taom X' }],
      ['patch', `${API}/venue`, { description: 'x' }], ['post', `${API}/uploads/sign`, { purpose: 'venue_photo' }], ['post', `${API}/venue/photos`, { public_id: 'abcdef' }],
      ['post', `${API}/employees`, { name: 'Ali Vali' }],
    ] as const) {
      const r = await ({ get, post, patch, put } as any)[m](p, ...(m === 'get' ? [S] : [b, S]));
      assert.equal(r.status, 403, `${m} ${p} -> ${r.status}`);
    }
    const emps = (await get(`${API}/employees`, S)).body;
    for (const e of emps) for (const k of ['rate', 'pay_type', 'paid_this_month', 'app_phone', 'note']) assert.ok(!(k in e), `ishchi ${k}`);
    assert.ok(Array.isArray((await get(`${API}/menus`, S)).body), 'menyuni ko‘radi');
    assert.equal((await get(`${API}/clients`, S)).status, 200);
  });
});

describe('moliya', () => {
  test('ko‘rsatkichlar to‘lovlar bilan mos; xarajat; operatsiyalar ro‘yxati', async () => {
    const o0 = (await get(`${API}/finance/overview`, O)).body;
    const b = (await post(`${API}/bookings`, newBooking({ total: 20_000_000, stage: 'deposit' }), O)).body;
    await post(`${API}/bookings/${b.id}/payments`, { kind: 'deposit', amount: 4_000_000, method: 'cash' }, O);
    await post(`${API}/bookings/${b.id}/payments`, { kind: 'payment', amount: 6_000_000, method: 'card' }, O);
    const o1 = (await get(`${API}/finance/overview`, O)).body;
    assert.equal(o1.revenue - o0.revenue, 10_000_000);
    assert.equal(o1.deposit - o0.deposit, 4_000_000);
    assert.equal(o1.paid - o0.paid, 6_000_000);
    assert.equal(o1.today_income - o0.today_income, 10_000_000);
    assert.equal(o1.remaining - o0.remaining, 10_000_000, 'qoldiq: 20 mln − 10 mln');
    assert.equal(o1.expected - o0.expected, 10_000_000);
    assert.equal(o1.expected_clients - o0.expected_clients, 1);

    const tx = await post(`${API}/transactions`, { type: 'expense', category: 'kommunal', amount: 1_500_000, note: 'Elektr' }, O);
    assert.equal(tx.status, 201, JSON.stringify(tx.body));
    assert.equal(tx.body.title, 'Xarajat (kommunal)'); assert.equal(tx.body.deletable, true);
    assert.equal((await post(`${API}/transactions`, { type: 'expense', category: 'yoq', amount: 1000 }, O)).status, 422);
    const o2 = (await get(`${API}/finance/overview`, O)).body;
    assert.equal(o2.expenses - o1.expenses, 1_500_000);
    assert.equal(o2.revenue, o1.revenue, 'xarajat daromadni kamaytirmaydi');

    const ops = (await get(`${API}/finance/operations`, O)).body;
    assert.ok(ops.items.some((i: any) => i.id === tx.body.id && i.type === 'expense'));
    assert.ok(ops.items.some((i: any) => i.booking_id === b.id && i.type === 'deposit' && i.amount === 4_000_000 && i.title === 'Zakalat'));
    assert.ok(ops.items.every((i: any, k: number, a: any[]) => k === 0 || a[k - 1].at >= i.at), 'yangisi tepada');
    const inc = (await get(`${API}/finance/operations?type=income`, O)).body.items;
    assert.ok(inc.every((i: any) => i.type === 'deposit' || i.type === 'income'));
    const exp = (await get(`${API}/finance/operations?type=expense`, O)).body.items;
    assert.ok(exp.every((i: any) => i.type === 'expense' || i.type === 'refund'));
    assert.equal((await del(`${API}/transactions/${tx.body.id}`, O)).status, 200);
    assert.equal((await get(`${API}/finance/overview`, O)).body.expenses, o1.expenses);
  });
});

describe('menyu va taomlar', () => {
  test('menyu yaratish: taomlar katalogga tushadi, items_text va mijoz ilovasi bilan sinxron, min_guests', async () => {
    const r = await post(`${API}/menus`, { name: 'To‘y №9', price_per_person: 210_000, min_guests: 300, dishes: ['Palov', 'Yangi taom', 'palov'] }, O);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.dishes.map((d: any) => d.name), ['Palov', 'Yangi taom'], 'takrorlar birlashadi');
    assert.equal(r.body.items_text, 'Palov, Yangi taom');
    assert.equal(r.body.min_guests, 300);
    assert.equal((await post(`${API}/menus`, { name: 'to‘y №9', price_per_person: 1000, dishes: ['x y'] }, O)).status, 409, 'nom takrorlanmaydi');
    assert.equal((await post(`${API}/menus`, { name: 'Bo‘sh', price_per_person: 1000, dishes: [] }, O)).status, 422);

    const detail = (await get(`/api/venues/navroz-saroyi?lat=41.28&lng=69.2`)).body;
    const pub = detail.menu_packages.find((m: any) => m.id === r.body.id);
    assert.equal(pub.items_text, 'Palov, Yangi taom'); assert.equal(pub.price_per_guest, 210_000); assert.equal(pub.min_guests, 300);
    const q = await post('/api/quote', { venue_id: me.venue.id, hall_id: hall0, date: nextDate(), session: 'evening', guests: 200, menu_package_id: r.body.id, vendor_ids: [] });
    assert.equal(q.status, 422); assert.match(q.body.message, /kamida 300/);

    const upd = await patch(`${API}/menus/${r.body.id}`, { price_per_person: 220_000, dishes: ['Yangi taom', 'Shashlik'] }, O);
    assert.equal(upd.body.price_per_person, 220_000); assert.equal(upd.body.items_text, 'Yangi taom, Shashlik');

    // ishlatilgan menyu "ommabop"
    const menus = (await get(`${API}/menus`, O)).body;
    assert.equal(menus.filter((m: any) => m.popular).length, 1);
    assert.ok(menus.find((m: any) => m.popular).used_count > 0);
    assert.equal((await del(`${API}/menus/${r.body.id}`, O)).status, 200);
  });

  test('taomlar: ro‘yxat, qayta nomlash menyuga ta’sir qiladi, o‘chirish menyudan ham olib tashlaydi', async () => {
    const m = (await post(`${API}/menus`, { name: 'Sinov menyu', price_per_person: 100_000, dishes: ['Sinov taomi', 'Palov'] }, O)).body;
    const dishes = (await get(`${API}/dishes`, O)).body;
    const d = dishes.find((x: any) => x.name === 'Sinov taomi');
    assert.equal(d.menus_count, 1); assert.equal(d.photo, null);
    assert.equal((await patch(`${API}/dishes/${d.id}`, { name: 'palov' }, O)).status, 409, 'nom band');
    const ren = await patch(`${API}/dishes/${d.id}`, { name: 'Sinov taom 2' }, O);
    assert.equal(ren.body.name, 'Sinov taom 2');
    assert.equal((await get(`${API}/menus`, O)).body.find((x: any) => x.id === m.id).items_text, 'Sinov taom 2, Palov');
    assert.equal((await del(`${API}/dishes/${d.id}`, O)).status, 200);
    assert.equal((await get(`${API}/menus`, O)).body.find((x: any) => x.id === m.id).items_text, 'Palov');
    assert.equal((await del(`${API}/menus/${m.id}`, O)).status, 200);
  });

  test('oxirgi menyu paketini o‘chirib bo‘lmaydi', async () => {
    const o2 = await signIn('+998907770001', 'oltin123');
    const menus = (await get(`${API}/menus`, bearer(o2.token))).body;
    for (const m of menus.slice(1)) assert.equal((await del(`${API}/menus/${m.id}`, bearer(o2.token))).status, 200);
    const last = await del(`${API}/menus/${menus[0].id}`, bearer(o2.token));
    assert.equal(last.status, 409); assert.equal(last.body.code, 'last_menu');
  });
});

describe('xodimlar', () => {
  test('ilovaga kirish bilan yaratish, xodim sifatida kirish, o‘chirilganda sessiya yopiladi', async () => {
    const c = await post(`${API}/employees`, { name: 'Sardor Ofitsiant', phone: '91 111 22 33', position: 'Ofitsiant', pay_type: 'per_event', rate: 200_000, app_access: true, app_password: 'sardor123' }, O);
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.app_access, true); assert.equal(c.body.app_phone, '+998911112233');
    assert.ok(!('password_hash' in c.body));
    assert.equal((await post(`${API}/employees`, { name: 'Boshqa', phone: '+998911112233', app_access: true, app_password: 'sardor123' }, O)).status, 409, 'telefon takrorlanmaydi');
    assert.equal((await post(`${API}/employees`, { name: 'Parolsiz', phone: '+998911119999', app_access: true }, O)).status, 422, 'parol shart');
    const t = await signIn('+998911112233', 'sardor123');
    assert.deepEqual(t.roles, ['staff']);
    assert.equal((await get(`${API}/bookings`, bearer(t.token))).status, 200);

    const upd = await patch(`${API}/employees/${c.body.id}`, { position: 'Katta ofitsiant', rate: 250_000 }, O);
    assert.equal(upd.body.position, 'Katta ofitsiant'); assert.equal(upd.body.rate, 250_000);
    const pwd = await patch(`${API}/employees/${c.body.id}`, { app_password: 'yangi-sardor1' }, O);
    assert.equal(pwd.status, 200);
    assert.equal((await get(`${API}/bookings`, bearer(t.token))).status, 401, 'parol almashgach eski sessiya yopiladi');
    const t2 = await signIn('+998911112233', 'yangi-sardor1');

    // ish haqi xarajati xodimga bog'lanadi
    const sal = await post(`${API}/transactions`, { type: 'expense', category: 'ish_haqi', amount: 2_000_000, employee_id: c.body.id }, O);
    assert.equal(sal.status, 201); assert.match(sal.body.subtitle, /Sardor/);
    assert.equal((await get(`${API}/employees`, O)).body.find((e: any) => e.id === c.body.id).paid_this_month, 2_000_000);

    assert.equal((await del(`${API}/employees/${c.body.id}`, O)).status, 200);
    assert.equal((await get(`${API}/bookings`, bearer(t2.token))).status, 401, 'o‘chirilgan xodim darhol chiqariladi');
    assert.equal((await post(`${API}/auth/login`, { phone: '+998911112233', password: 'yangi-sardor1' })).status, 401);
    assert.ok(!(await get(`${API}/employees`, S)).body.some((e: any) => e.id === c.body.id), 'xodimlar ro‘yxatidan yo‘qoladi (xodim ko‘rinishida)');
  });

  test('bir telefon ham egasi, ham xodim: ikkala rol, har biri o‘z tokeni bilan', async () => {
    const e = await post(`${API}/employees`, { name: 'Egasi ham xodim', phone: DEMO.owner.phone, app_access: true, app_password: DEMO.owner.password }, O);
    assert.equal(e.status, 201);
    const l = await post(`${API}/auth/login`, { phone: DEMO.owner.phone, password: DEMO.owner.password });
    assert.deepEqual([...l.body.roles].sort(), ['owner', 'staff']);
    assert.equal((await get(`${API}/auth/session`, bearer(l.body.token))).status, 422, 'rol tanlanmasa — so‘raladi');
    const as = await get(`${API}/auth/session?role=staff`, bearer(l.body.token));
    assert.equal(as.body.user.role, 'staff');
    assert.ok(!('total' in (await get(`${API}/bookings?limit=1`, bearer(as.body.token))).body[0]));
    const ao = await get(`${API}/auth/session?role=owner`, bearer(l.body.token));
    assert.ok('total' in (await get(`${API}/bookings?limit=1`, bearer(ao.body.token))).body[0]);
    await del(`${API}/employees/${e.body.id}`, O);
  });
});

describe('mijozlar va kalendar', () => {
  test('mijozlar telefon bo‘yicha jamlanadi (bekor qilinganlar ham sanaladi), qidiruv', async () => {
    const d1 = nextDate(); const d2 = nextDate();
    await post(`${API}/bookings`, newBooking({ date: d1, customer_name: 'Takroriy Mijoz', customer_phone: '+998 94 000 11 22' }), O);
    const b2 = (await post(`${API}/bookings`, newBooking({ date: d2, customer_name: 'Takroriy Mijoz', customer_phone: '94 000 11 22' }), O)).body;
    await post(`${API}/bookings/${b2.id}/status`, { status: 'cancelled' }, O);
    const cl = (await get(`${API}/clients?q=Takroriy`, O)).body;
    assert.equal(cl.length, 1);
    assert.equal(cl[0].bookings_count, 2); assert.equal(cl[0].phone, '+998940001122');
    assert.equal(cl[0].last_booking.date, d1, 'eng dolzarb bron — yaqin kelajakdagisi');
    assert.equal((await get(`${API}/clients?q=94 000`, O)).body.length, 1);
  });

  test('oylik kalendar: bronlar (bekor qilinmaganlar) va yopiq seanslar', async () => {
    const date = nextDate();
    const b = (await post(`${API}/bookings`, newBooking({ date }), O)).body;
    const closedDate = nextDate();
    assert.equal((await put('/api/admin/slots', { hall_id: hall1, date: closedDate, session: 'day', status: 'closed', note: 'Ta’mir' }, ADMIN)).status, 200);
    const cal = (await get(`${API}/calendar?month=${date.slice(0, 7)}`, O)).body;
    assert.ok(cal.bookings.some((x: any) => x.id === b.id));
    assert.ok(cal.bookings.every((x: any) => x.status !== 'cancelled'));
    const m2 = (await get(`${API}/calendar?month=${closedDate.slice(0, 7)}`, O)).body;
    assert.ok(m2.closed.some((c: any) => c.date === closedDate && c.session === 'day' && c.note === 'Ta’mir'));
    assert.equal((await get(`${API}/calendar?month=2026-13`, O)).status, 422);
  });
});

describe('Cloudinary: rasmlar', () => {
  test('imzo algoritmi Cloudinary hujjatidagi misol bilan mos', () => {
    const sig = signParams({ eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: 1315060510 }, 'abcd');
    assert.equal(sig, 'bfd09f95f331f558cbd1320e67aa8d488770583e');
    // file, api_key, cloud_name, resource_type imzoga kirmaydi
    assert.equal(signParams({ file: 'x', api_key: 'k', cloud_name: 'c', resource_type: 'image', public_id: 'sample_image', timestamp: 1 }, 's'),
      signParams({ public_id: 'sample_image', timestamp: 1 }, 's'));
  });

  test('yuklash chiptasi: imzolangan, to‘yxona papkasida, xodimga berilmaydi', async () => {
    const r = await post(`${API}/uploads/sign`, { purpose: 'venue_photo' }, O);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.upload_url, 'https://api.cloudinary.com/v1_1/demo-cloud/image/upload');
    assert.ok(r.body.public_id.startsWith(`lokma-toyxonalar/venues/${me.venue.id}/gallery/`));
    const f = r.body.fields;
    assert.equal(f.api_key, '123456789012345');
    assert.equal(f.public_id, r.body.public_id);
    assert.equal(f.allowed_formats, 'jpg,jpeg,png,webp,heic,heif');
    assert.equal(f.signature, signParams({ allowed_formats: f.allowed_formats, overwrite: f.overwrite, public_id: f.public_id, timestamp: f.timestamp }, 'test-cloudinary-secret'));
    assert.ok(!JSON.stringify(r.body).includes('test-cloudinary-secret'), 'maxfiy kalit chiqmasin');
    assert.equal((await post(`${API}/uploads/sign`, { purpose: 'dish_photo' }, O)).body.public_id.includes('/dishes/'), true);
    assert.equal((await post(`${API}/uploads/sign`, { purpose: 'xxx' }, O)).status, 422);
    assert.equal((await post(`${API}/uploads/sign`, { purpose: 'venue_photo' }, S)).status, 403);
    assert.equal((await post(`${API}/uploads/sign`, { purpose: 'venue_photo' })).status, 401);
  });

  test('sozlanmagan Cloudinary — 503', () => {
    assert.throws(() => requireCloudinary({ cloudName: '', apiKey: '', apiSecret: '', folder: 'x' }), (e: any) => e.status === 503 && e.code === 'cloudinary_not_configured');
  });

  test('galereya: eski rasmlar saqlanadi, yangisi qo‘shiladi, tartib, muqova, mijoz ilovasida ko‘rinadi, o‘chirish Cloudinary’dan ham', async () => {
    const before = (await get(`${API}/venue/photos`, O)).body;
    assert.equal(before.length, 12, 'eski (tashqi) rasmlar ko‘chirildi');
    assert.equal(before[0].external, true);
    const t = (await post(`${API}/uploads/sign`, { purpose: 'venue_photo' }, O)).body;
    const added = await post(`${API}/venue/photos`, { public_id: t.public_id }, O);
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.length, 13);
    const mine = added.body[12];
    assert.equal(mine.public_id, t.public_id);
    assert.equal(mine.url, `https://res.cloudinary.com/demo-cloud/image/upload/c_limit,w_1600,f_auto,q_auto/v1700000000/${t.public_id}`);
    assert.ok(mine.thumb_url.includes('c_fill,g_auto,w_240,h_240'));
    assert.equal(mine.width, 1600);
    assert.ok(cloudCalls.some((c) => c.url.endsWith(`/resources/image/upload/${t.public_id}`)), 'Cloudinary’da mavjudligi tekshirildi');
    assert.equal((await post(`${API}/venue/photos`, { public_id: t.public_id }, O)).body.length, 13, 'takroriy so‘rov bir xil natija');

    // muqovaga ko'tarish
    const ids = added.body.map((p: any) => p.id);
    const order = [ids[12], ...ids.slice(0, 12)];
    const re = await put(`${API}/venue/photos/order`, { ids: order }, O);
    assert.equal(re.body[0].public_id, t.public_id); assert.equal(re.body[0].is_cover, true);
    assert.equal((await put(`${API}/venue/photos/order`, { ids: ids.slice(1) }, O)).status, 422, 'to‘liq ro‘yxat kerak');

    // mijoz ilovasi: birinchi surat — Cloudinary, ro'yxatda kichikroq o'lcham
    const detail = (await get(`/api/venues/navroz-saroyi?lat=41.28&lng=69.2`)).body;
    assert.equal(detail.photos.length, 13);
    assert.ok(detail.photos[0].includes('res.cloudinary.com') && detail.photos[0].includes('w_1600'));
    const list = (await get('/api/venues?lat=41.2856&lng=69.2034&radius_km=5&q=Navro')).body[0];
    assert.ok(list.photos[0].includes('w_900') && !list.photos[0].includes('w_1600'), 'ro‘yxat kartasida yengil o‘lcham');
    assert.equal(list.photos_count, 13);

    // o'chirish
    const calls0 = cloudCalls.length;
    const rm = await del(`${API}/venue/photos/${re.body[0].id}`, O);
    assert.equal(rm.status, 200); assert.equal(rm.body.length, 12);
    await new Promise((r) => setTimeout(r, 50));
    const destroy = cloudCalls.slice(calls0).find((c) => c.url.endsWith('/image/destroy'));
    assert.ok(destroy, 'Cloudinary’dan ham o‘chirildi');
    const form = new URLSearchParams(destroy!.body);
    assert.equal(form.get('public_id'), t.public_id);
    assert.equal(form.get('signature'), signParams({ invalidate: 'true', public_id: t.public_id, timestamp: form.get('timestamp')! }, 'test-cloudinary-secret'));
    assert.ok(!(await get('/api/venues/navroz-saroyi?lat=41.28&lng=69.2')).body.photos.some((u: string) => u.includes(t.public_id)));
  });

  test('begona to‘yxona yoki papka identifikatori, mavjud bo‘lmagan rasm rad etiladi', async () => {
    const other = `lokma-toyxonalar/venues/aaaaaaaaaaaaaaaaaaaaaaaa/gallery/abc123`;
    assert.equal((await post(`${API}/venue/photos`, { public_id: other }, O)).status, 422);
    assert.equal((await post(`${API}/venue/photos`, { public_id: `lokma-toyxonalar/venues/${me.venue.id}/dishes/abc123` }, O)).status, 422, 'taom papkasi galereyaga emas');
    assert.equal((await post(`${API}/venue/photos`, { public_id: `lokma-toyxonalar/venues/${me.venue.id}/gallery/../x` }, O)).status, 422);
    const missing = await post(`${API}/venue/photos`, { public_id: `lokma-toyxonalar/venues/${me.venue.id}/gallery/missing1` }, O);
    assert.equal(missing.status, 422); assert.equal(missing.body.code, 'asset_missing');
    assert.doesNotThrow(() => assertOwnedPublicId('x/y', 'x'));
    assert.throws(() => assertOwnedPublicId('x/y/z', 'x'), /noto‘g‘ri/, 'ichki papka bo‘lmasin');
  });

  test('taom va menyu rasmi: biriktirish, almashtirish (eskisi o‘chadi), olib tashlash', async () => {
    const t = (await post(`${API}/uploads/sign`, { purpose: 'dish_photo' }, O)).body;
    const d = (await post(`${API}/dishes`, { name: 'Rasmli taom', photo_public_id: t.public_id }, O)).body;
    assert.equal(d.photo.public_id, t.public_id); assert.ok(d.photo.thumb_url.includes('w_240'));
    // taom rasmi galereya papkasidan bo'lsa — rad
    const g = (await post(`${API}/uploads/sign`, { purpose: 'venue_photo' }, O)).body;
    assert.equal((await post(`${API}/dishes`, { name: 'Xato rasm', photo_public_id: g.public_id }, O)).status, 422);
    const t2 = (await post(`${API}/uploads/sign`, { purpose: 'dish_photo' }, O)).body;
    const calls0 = cloudCalls.length;
    const rep = await patch(`${API}/dishes/${d.id}`, { photo_public_id: t2.public_id }, O);
    assert.equal(rep.body.photo.public_id, t2.public_id);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(cloudCalls.slice(calls0).some((c) => c.url.endsWith('/image/destroy') && c.body?.includes(encodeURIComponent(t.public_id))), 'eski rasm o‘chirildi');
    const clr = await patch(`${API}/dishes/${d.id}`, { photo_public_id: null }, O);
    assert.equal(clr.body.photo, null);
    const mt = (await post(`${API}/uploads/sign`, { purpose: 'menu_photo' }, O)).body;
    const menu = await post(`${API}/menus`, { name: 'Rasmli menyu', price_per_person: 90_000, dishes: ['Rasmli taom'], photo_public_id: mt.public_id }, O);
    assert.equal(menu.body.photo.public_id, mt.public_id);
    await del(`${API}/menus/${menu.body.id}`, O); await del(`${API}/dishes/${d.id}`, O);
  });

  test('rasm URL yordamchilari', () => {
    const u = imageUrl({ public_id: 'a/b', version: 5 }, 'card');
    assert.equal(u, 'https://res.cloudinary.com/demo-cloud/image/upload/c_limit,w_900,f_auto,q_auto/v5/a/b');
    assert.equal(resizeUrl(imageUrl({ public_id: 'a/b', version: 5 }, 'large'), 'card'), u);
    assert.equal(resizeUrl('https://images.unsplash.com/photo-1?w=1200', 'card'), 'https://images.unsplash.com/photo-1?w=1200');
    const tk = createUploadTicket('p', { cloudName: 'c', apiKey: 'k', apiSecret: 's', folder: 'f' }, 1_700_000_000_000);
    assert.equal(tk.fields.timestamp, '1700000000');
  });

  test('Cloudinary o‘chirish xatosi (tarmoq) — DB amaliga halal bermaydi', async () => {
    setCloudinaryFetch(async () => { throw new Error('tarmoq yo‘q'); });
    assert.equal(await destroyAsset('x/y'), false);
    setCloudinaryFetch(async (url) => new Response(JSON.stringify(url.includes('/resources/') ? { public_id: 'x', version: 1 } : { result: 'ok' }), { status: 200 }));
  });
});

describe('arizalar: yangi to‘yxona', () => {
  test('ommaviy ariza: rasmlar bilan, takroriy yuborish, admin ko‘rib chiqadi', async () => {
    const t = await post(`${API}/applications/uploads/sign`);
    assert.equal(t.status, 200);
    assert.ok(t.body.public_id.startsWith('lokma-toyxonalar/applications/'));
    const body = { name: 'Yangi Saroy', address: 'Toshkent, Chilonzor', phone: '90 555 44 33', halls: 2, capacity: 400, services: ['Oshpaz', 'Dekor'], photos: [t.body.public_id], price_from: 100_000, price_to: 200_000, notes: 'Salom' };
    const r = await post(`${API}/applications`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const dup = await post(`${API}/applications`, body);
    assert.equal(dup.status, 200); assert.equal(dup.body.duplicate, true); assert.equal(dup.body.id, r.body.id);
    assert.equal((await post(`${API}/applications`, { ...body, phone: '12' })).status, 422);
    assert.equal((await post(`${API}/applications`, { ...body, phone: '91 000 00 00', photos: ['lokma-toyxonalar/venues/x/gallery/zzz'] })).status, 422, 'begona papka');
    assert.equal((await post(`${API}/applications`, { ...body, phone: '91 000 00 01', name: 'A' })).status, 422);

    assert.equal((await get('/api/admin/applications')).status, 403);
    const list = (await get('/api/admin/applications?status=new', ADMIN)).body;
    const a = list.find((x: any) => x._id === r.body.id);
    assert.equal(a.phone, '+998905554433'); assert.equal(a.photos.length, 1); assert.ok(a.photos[0].url.includes('res.cloudinary.com'));
    const up = await patch(`/api/admin/applications/${r.body.id}`, { status: 'contacted', admin_note: 'Qo‘ng‘iroq qilindi' }, ADMIN);
    assert.equal(up.body.status, 'contacted');
    assert.equal((await get('/api/admin/applications?status=new', ADMIN)).body.some((x: any) => x._id === r.body.id), false);
  });
});

describe('profil va hisob', () => {
  test('to‘yxona ma’lumotini yangilash mijoz ilovasida ko‘rinadi', async () => {
    const r = await patch(`${API}/venue`, { description: 'Yangilangan tavsif', amenities: ['Wi-Fi', 'Konditsioner'], parking_spots: 77, phone: '+998712223344' }, O);
    assert.equal(r.status, 200);
    assert.equal(r.body.venue.parking_spots, 77);
    const pub = (await get('/api/venues/navroz-saroyi?lat=41.28&lng=69.2')).body;
    assert.equal(pub.description, 'Yangilangan tavsif'); assert.deepEqual(pub.amenities, ['Wi-Fi', 'Konditsioner']); assert.equal(pub.parking_spots, 77);
    assert.equal((await patch(`${API}/venue`, { name: 'Hack', status: 'blocked' }, O)).status, 200, 'ruxsat etilmagan maydonlar e’tiborsiz');
    assert.equal((await get(`${API}/me`, O)).body.venue.name, 'Navro‘z Saroyi');
    assert.equal((await get(`${API}/me`, O)).body.venue.status, 'active');
  });

  test('obuna holati /me da ko‘rinadi', async () => {
    await patch(`/api/admin/venues/${me.venue.id}`, { subscription: { monthly_fee: 500_000, paid_until: '2020-01-31' } }, ADMIN);
    const s = (await get(`${API}/me`, O)).body.venue.subscription;
    assert.equal(s.state, 'overdue'); assert.equal(s.monthly_fee, 500_000);
    await patch(`/api/admin/venues/${me.venue.id}`, { subscription: { monthly_fee: 0, paid_until: '' } }, ADMIN);
  });

  test('hisobni o‘chirish: token va login yopiladi; egasi uchun admin qayta yoqadi', async () => {
    const c = await post(`${API}/employees`, { name: 'Vaqtinchalik', phone: '+998933334455', app_access: true, app_password: 'vaqt1234' }, O);
    const t = await signIn('+998933334455', 'vaqt1234');
    assert.equal((await del(`${API}/account`, bearer(t.token))).status, 200);
    assert.equal((await get(`${API}/me`, bearer(t.token))).status, 401);
    assert.equal((await post(`${API}/auth/login`, { phone: '+998933334455', password: 'vaqt1234' })).status, 401);
    assert.ok((await get(`${API}/employees`, O)).body.find((e: any) => e.id === c.body.id), 'ishchi yozuvi saqlanadi');

    const o2 = await signIn('+998907770001', 'oltin123');
    assert.equal((await del(`${API}/account`, bearer(o2.token))).status, 200);
    assert.equal((await post(`${API}/auth/login`, { phone: '+998907770001', password: 'oltin123' })).status, 401);
    const other = (await get('/api/venues?lat=41.2995&lng=69.2401&radius_km=5&q=Oltin')).body[0];
    assert.equal((await put(`/api/admin/venues/${other.id}/account`, { login: 'oltin', active: true }, ADMIN)).status, 200);
    assert.equal((await post(`${API}/auth/login`, { phone: '+998907770001', password: 'oltin123' })).status, 200, 'admin tiklagach kirish mumkin');
  });
});

describe('SMS provayder (Eskiz)', () => {
  test('Eskiz orqali yuboriladi; token eskirsa qayta autentifikatsiya', async () => {
    const { env } = await import('../src/config/env.js');
    const { resetSmsCache } = await import('../src/modules/owner-app/sms.service.js');
    (env as any).SMS_PROVIDER = 'eskiz'; (env as any).ESKIZ_EMAIL = 'a@b.uz'; (env as any).ESKIZ_PASSWORD = 'pw';
    resetSmsCache();
    const log: string[] = [];
    let sends = 0;
    setSmsFetch(async (url, init) => {
      log.push(url.replace('https://notify.eskiz.uz/api', ''));
      if (url.endsWith('/auth/login')) return new Response(JSON.stringify({ data: { token: `tok${log.length}` } }), { status: 200 });
      sends++;
      if (sends === 1) return new Response('{}', { status: 401 }); // eskirgan token
      const form = new URLSearchParams(init!.body as URLSearchParams);
      assert.equal(form.get('mobile_phone'), DEMO.staff.phone.replace('+', ''));
      assert.match(form.get('message')!, /tasdiqlash kodi \d{6}/);
      return new Response('{}', { status: 200 });
    });
    const r = await post(`${API}/auth/forgot`, { phone: DEMO.staff.phone });
    assert.equal(r.status, 200); assert.equal(r.body.dev_code, undefined, 'SMS yuborilgan bo‘lsa kod javobda qaytmaydi');
    assert.deepEqual(log, ['/auth/login', '/message/sms/send', '/auth/login', '/message/sms/send']);
    setSmsFetch(async () => new Response('{}', { status: 500 }));
    resetSmsCache();
    const bad = await post(`${API}/auth/forgot`, { phone: DEMO.staff.phone });
    assert.equal(bad.status, 502);
    (env as any).SMS_PROVIDER = 'none'; setSmsFetch(null);
  });
});
