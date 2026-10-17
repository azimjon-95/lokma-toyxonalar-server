/*
 * Egasi so'rovlar qutisi — HAQIQIY marshrut kodi (owner.inbox.ts), HTTP orqali.
 * Baza o'rniga xotiradagi soxta modellar (find/update operatorlari: $set, $push, $unset, $in, $exists, $gt, $lte).
 * Ishga tushirish: npx tsx --test test/inbox-routes.test.ts
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { HttpError } from '../src/lib/http-error.js';
import { BookingModel } from '../src/modules/bookings/booking.model.js';
import { SlotModel } from '../src/modules/slots/slot.model.js';
import { TransactionModel } from '../src/modules/owner/owner.models.js';
import { OwnerNotificationModel, notifyExpired, remindUnanswered } from '../src/modules/owner/owner.notifications.js';
import { registerInboxRoutes } from '../src/modules/owner/owner.inbox.js';

type Doc = Record<string, any>;
const VENUE = new Types.ObjectId();
const OTHER_VENUE = new Types.ObjectId();
const same = (a: unknown, b: unknown) => String(a) === String(b);

/* ── mini-mongo ── */
function matches(d: Doc, f: Doc): boolean {
  return Object.entries(f).every(([k, v]) => {
    if (k === '$or') return (v as Doc[]).some((x) => matches(d, x));
    const val = d[k];
    if (v && typeof v === 'object' && !(v instanceof Types.ObjectId) && !(v instanceof Date)) {
      return Object.entries(v as Doc).every(([op, x]) => {
        if (op === '$in') return (x as unknown[]).some((y) => same(y, val));
        if (op === '$ne') return !same(val, x);
        if (op === '$exists') return (val !== undefined) === x;
        if (op === '$gt') return val > (x as never);
        if (op === '$gte') return val >= (x as never);
        if (op === '$lt') return val < (x as never);
        if (op === '$lte') return val <= (x as never);
        return false;
      });
    }
    return same(val, v);
  });
}
function apply(d: Doc, u: Doc) {
  for (const [k, v] of Object.entries(u.$set ?? {})) d[k] = v;
  for (const k of Object.keys(u.$unset ?? {})) delete d[k];
  for (const [k, v] of Object.entries(u.$push ?? {})) {
    d[k] ??= [];
    const items = v && typeof v === 'object' && '$each' in (v as Doc) ? (v as Doc).$each : [v];
    d[k].push(...items);
  }
}
/** Chuqur nusxa: ObjectId va Date o'zgarishsiz (structuredClone ObjectId'ni buzadi; haqiqiy lean() buzmaydi) */
function clone<T>(v: T): T {
  if (v instanceof Types.ObjectId || v instanceof Date || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone) as T;
  return Object.fromEntries(Object.entries(v as Doc).map(([k, x]) => [k, clone(x)])) as T;
}
const lean = (v: unknown) => ({ lean: async () => clone(v) });
const queryOf = (rows: Doc[]) => ({ sort() { return this; }, limit() { return this; }, lean: async () => clone(rows) });

let bookings: Doc[] = [];
let slots: Doc[] = [];
let txs: Doc[] = [];
let notes: Doc[] = [];
const filters: Doc[] = [];

(BookingModel as any).findOne = (f: Doc) => lean(bookings.find((b) => matches(b, f)) ?? null);
(BookingModel as any).findOneAndUpdate = (f: Doc, u: Doc) => { const b = bookings.find((x) => matches(x, f)); if (b) apply(b, u); return lean(b ?? null); };
(BookingModel as any).updateOne = async (f: Doc, u: Doc) => { const b = bookings.find((x) => matches(x, f)); if (b) apply(b, u); return { modifiedCount: b ? 1 : 0 }; };
(BookingModel as any).find = (f: Doc) => { filters.push(f); return queryOf(bookings.filter((b) => matches(b, f))); };
(BookingModel as any).countDocuments = async (f: Doc) => bookings.filter((b) => matches(b, f)).length;
(SlotModel as any).findOne = (f: Doc) => lean(slots.find((s) => matches(s, f)) ?? null);
(SlotModel as any).updateOne = async (f: Doc, u: Doc) => { const s = slots.find((x) => matches(x, f)); if (s) apply(s, u); return {}; };
(SlotModel as any).deleteOne = async (f: Doc) => { const i = slots.findIndex((x) => matches(x, f)); if (i >= 0) slots.splice(i, 1); return {}; };
(TransactionModel as any).create = async (d: Doc) => { txs.push(d); return d; };
(OwnerNotificationModel as any).create = async (d: Doc) => { notes.push({ _id: new Types.ObjectId(), createdAt: new Date(), ...d }); return d; };
(OwnerNotificationModel as any).updateMany = async (f: Doc, u: Doc) => { for (const n of notes.filter((x) => matches(x, f))) apply(n, u); return {}; };
(OwnerNotificationModel as any).countDocuments = async (f: Doc) => notes.filter((n) => matches(n, f)).length;
(OwnerNotificationModel as any).findOne = () => ({ sort() { return this; }, lean: async () => (notes[0] ? { createdAt: notes[0].createdAt } : null) });
(OwnerNotificationModel as any).find = (f: Doc) => queryOf(notes.filter((n) => matches(n, f)));

const mk = (over: Doc = {}): Doc => ({
  _id: new Types.ObjectId(), number: 'TY-1', status: 'pending', stage: 'new', venue_id: VENUE, venue_name: 'Navro‘z', hall_id: new Types.ObjectId(), hall_name: 'Katta zal',
  date: '2026-12-24', session: 'day', event_type: 'nikoh', guests: 300, price_per_guest: 250000, venue_total: 75_000_000, total: 77_000_000, deposit: 15_400_000, extras: [],
  customer_name: 'Ali Valiyev', customer_phone: '+998901112233', hold_until: new Date(Date.now() + 20 * 3600_000), createdAt: new Date(), payments: [], timeline: [], ...over,
});
const withSlot = (b: Doc, status = 'hold') => { slots.push({ _id: new Types.ObjectId(), booking_id: b._id, status, hold_until: b.hold_until }); return b; };

let server: import('node:http').Server; let base = '';
const app = express();
before(async () => {
  app.use(express.json());
  const r = Router();
  r.use((req: Request & { venueId?: Types.ObjectId }, _res: Response, next: NextFunction) => { req.venueId = VENUE; next(); });
  registerInboxRoutes(r);
  app.use('/api/owner', r);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    res.status(500).json({ error: String(err) });
  });
  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/owner`;
});
after(() => { server.close(); });
const reset = () => { bookings = []; slots = []; txs = []; notes = []; filters.length = 0; };
const call = async (path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Doc };
};
const idOf = (b: Doc) => String(b._id);

test('ko‘rdim: seen belgilanadi, bildirishnoma o‘qilgan bo‘ladi', async () => {
  reset(); const b = withSlot(mk()); bookings.push(b);
  notes.push({ _id: new Types.ObjectId(), venue_id: VENUE, booking_id: b._id, kind: 'booking_new', createdAt: new Date() });
  const r = await call(`/inbox/${idOf(b)}/seen`, 'POST');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.seen_at, 'ko‘rilgan vaqt');
  assert.ok(notes[0].read_at, 'bildirishnoma o‘qildi');
  assert.equal(r.json.timeline.at(-1).kind, 'seen');
});

test('boshqa to‘yxonaning broni — 404 (egalik)', async () => {
  reset(); const b = mk({ venue_id: OTHER_VENUE }); bookings.push(b);
  for (const [p, m] of [[`/inbox/${idOf(b)}`, 'GET'], [`/inbox/${idOf(b)}/seen`, 'POST'], [`/inbox/${idOf(b)}/reject`, 'POST']] as const) {
    assert.equal((await call(p, m, m === 'POST' ? { reason_code: 'busy' } : undefined)).status, 404, `${m} ${p}`);
  }
});

test('kelishildi: bosqich, muddat uzaytiriladi (bron va seans), kelishilgan jami', async () => {
  reset(); const b = withSlot(mk()); bookings.push(b);
  const due = new Date(Date.now() + 4 * 86400_000).toISOString().slice(0, 10);
  const r = await call(`/inbox/${idOf(b)}/agree`, 'POST', { note: 'Gul bezagi bepul', advance_due: due, agreed_total: 70_000_000 });
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'agreed');
  assert.equal(r.json.total_effective, 70_000_000);
  assert.equal(r.json.agreed_note, 'Gul bezagi bepul');
  assert.equal(bookings[0].hold_until.toISOString(), new Date(`${due}T23:59:59+05:00`).toISOString(), 'bron muddati uzaydi');
  assert.equal(slots[0].hold_until.toISOString(), bookings[0].hold_until.toISOString(), 'seans muddati ham uzaydi (24 soatda bo‘shab ketmasin)');
  const bad = await call(`/inbox/${idOf(b)}/agree`, 'POST', { advance_due: '2020-01-01' });
  assert.equal(bad.status, 422, 'o‘tgan sana rad etiladi');
});

test('rad etish: sabab majburiy, seans bo‘shaydi, mijoz uchun sabab saqlanadi', async () => {
  reset(); const b = withSlot(mk()); bookings.push(b);
  assert.equal((await call(`/inbox/${idOf(b)}/reject`, 'POST', {})).status, 422, 'sababsiz');
  assert.equal((await call(`/inbox/${idOf(b)}/reject`, 'POST', { reason_code: 'other', note: '' })).status, 409, '"boshqa" — izohsiz');
  const r = await call(`/inbox/${idOf(b)}/reject`, 'POST', { reason_code: 'price', note: '5 mln kamaytirmadik' });
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'rejected');
  assert.match(r.json.reject_reason, /Narx/);
  assert.match(r.json.reject_reason, /5 mln/);
  assert.equal(bookings[0].cancelled_by, 'owner');
  assert.equal(slots.length, 0, 'seans bo‘shatildi');
  assert.equal((await call(`/inbox/${idOf(b)}/agree`, 'POST', {})).status, 409, 'rad etilganni kelishib bo‘lmaydi');
});

test('avans: tasdiqlandi, seans BAND, to‘lov yozildi, KIRIM avtomatik', async () => {
  reset(); const b = withSlot(mk({ stage: 'agreed' })); bookings.push(b);
  const r = await call(`/inbox/${idOf(b)}/advance`, 'POST', { amount: 15_000_000, method: 'cash', note: 'Otasi olib keldi' });
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'confirmed');
  assert.equal(r.json.paid, 15_000_000);
  assert.equal(r.json.balance, 62_000_000);
  assert.equal(r.json.payments[0].kind, 'deposit');
  assert.equal(slots[0].status, 'booked', 'seans band');
  assert.equal(slots[0].hold_until, undefined, 'ushlab turish olib tashlandi');
  assert.equal(txs.length, 1, 'kirim yozildi');
  assert.deepEqual([txs[0].type, txs[0].category, txs[0].amount, txs[0].method], ['income', 'bron', 15_000_000, 'cash']);
  assert.ok(same(txs[0].booking_id, b._id) && same(txs[0].venue_id, VENUE));
  assert.ok(r.json.timeline.some((t: Doc) => t.kind === 'confirmed'));
  assert.equal(bookings[0].advance_due, undefined);
});

test('avans: qoldiqdan oshmaydi; muddat tugab seans ketgan bo‘lsa — rad', async () => {
  reset(); const b = withSlot(mk()); bookings.push(b);
  assert.equal((await call(`/inbox/${idOf(b)}/advance`, 'POST', { amount: 77_000_001 })).status, 422);
  assert.equal(txs.length, 0, 'xatoda kirim yozilmaydi');
  reset(); const c = mk(); bookings.push(c); // seans yo'q (boshqa mijoz egallagan / tozalangan)
  const r = await call(`/inbox/${idOf(c)}/advance`, 'POST', { amount: 1_000_000 });
  assert.equal(r.status, 409);
  assert.match(String(r.json.error), /Muddat tugagan/);
  assert.equal(bookings[0].status, 'pending', 'bron o‘zgarmadi');
});

test('qo‘shimcha to‘lov (tasdiqlangan bron): kind=payment, qoldiq kamayadi', async () => {
  reset(); const b = withSlot(mk({ status: 'confirmed', payments: [{ _id: new Types.ObjectId(), amount: 15_000_000, kind: 'deposit', method: 'cash', date: '2026-10-20' }] }), 'booked'); bookings.push(b);
  const r = await call(`/inbox/${idOf(b)}/advance`, 'POST', { amount: 10_000_000, method: 'card' });
  assert.equal(r.status, 200);
  assert.equal(r.json.paid, 25_000_000);
  assert.equal(r.json.payments.at(-1).kind, 'payment');
  assert.equal(txs[0].method, 'card');
  assert.equal(r.json.state, 'confirmed');
});

test('avanssiz tasdiqlash: band qilinadi, kirim yozilmaydi', async () => {
  reset(); const b = withSlot(mk()); bookings.push(b);
  const r = await call(`/inbox/${idOf(b)}/confirm`, 'POST', { note: 'Ishonchli mijoz' });
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'confirmed');
  assert.equal(slots[0].status, 'booked');
  assert.equal(txs.length, 0);
});

test('tasdiqlangan bronni bekor qilish: sabab majburiy, seans bo‘shaydi, to‘langan haqida eslatma', async () => {
  reset(); const b = withSlot(mk({ status: 'confirmed', payments: [{ _id: new Types.ObjectId(), amount: 5_000_000, kind: 'deposit', method: 'cash', date: '2026-10-20' }] }), 'booked'); bookings.push(b);
  assert.equal((await call(`/inbox/${idOf(b)}/cancel`, 'POST', {})).status, 422);
  const r = await call(`/inbox/${idOf(b)}/cancel`, 'POST', { reason_code: 'declined' });
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'cancelled');
  assert.equal(slots.length, 0);
  assert.match(r.json.timeline.at(-1).text, /qaytarishni/);
  assert.equal((await call(`/inbox/${idOf(b)}/advance`, 'POST', { amount: 1000 })).status, 409, 'bekor qilinganga to‘lov yo‘q');
});

test('muddati o‘tgan so‘rov: hech qanday amal yo‘q', async () => {
  reset(); const b = withSlot(mk({ hold_until: new Date(Date.now() - 1000) })); bookings.push(b);
  for (const [a, body] of [['agree', {}], ['reject', { reason_code: 'busy' }], ['advance', { amount: 1000 }], ['confirm', {}]] as const) {
    assert.equal((await call(`/inbox/${idOf(b)}/${a}`, 'POST', body)).status, 409, a);
  }
  assert.equal((await call(`/inbox/${idOf(b)}`)).json.state, 'expired');
});

test('ro‘yxat: filtrlar (yangi/kelishilgan/tasdiqlangan), venue bilan cheklangan; xulosa', async () => {
  reset(); bookings.push(mk(), mk({ stage: 'agreed' }), mk({ status: 'confirmed' }), mk({ venue_id: OTHER_VENUE }));
  notes.push({ _id: new Types.ObjectId(), venue_id: VENUE, kind: 'booking_new', createdAt: new Date() });
  const r = await call('/inbox?state=new');
  assert.equal(r.status, 200);
  assert.equal(r.json.items.length, 1, 'faqat "new"');
  assert.deepEqual(r.json.counts, { new: 1, agreed: 1, confirmed: 1 }, 'boshqa to‘yxona hisobga olinmaydi');
  assert.ok(filters.every((f) => same(f.venue_id, VENUE) || f.$or), 'har so‘rov venue_id bilan');
  const s = await call('/inbox/summary');
  assert.equal(s.json.unread, 1);
  assert.deepEqual(s.json.counts, { new: 1, agreed: 1, confirmed: 1 });
  assert.equal((await call('/inbox?state=wrong')).status, 422);
});

test('bildirishnomalar: ro‘yxat va o‘qilgan deb belgilash', async () => {
  reset();
  notes.push({ _id: new Types.ObjectId(), venue_id: VENUE, kind: 'booking_new', title: 'Yangi', body: 'x', createdAt: new Date() }, { _id: new Types.ObjectId(), venue_id: VENUE, kind: 'booking_expired', title: 'Tugadi', createdAt: new Date() });
  let r = await call('/notifications');
  assert.equal(r.json.unread, 2);
  assert.equal(r.json.items.length, 2);
  await call('/notifications/read', 'POST', { ids: [String(notes[0]._id)] });
  r = await call('/notifications');
  assert.equal(r.json.unread, 1);
  await call('/notifications/read', 'POST', {});
  assert.equal((await call('/notifications')).json.unread, 0);
  assert.equal((await call('/notifications/read', 'POST', { ids: ['zzz'] })).status, 422);
});

test('eslatma: 30 daqiqa ko‘rilmagan so‘rov — BIR marta bildirishnoma', async () => {
  reset();
  const old = mk({ createdAt: new Date(Date.now() - 31 * 60_000) });
  const fresh2 = mk({ createdAt: new Date(Date.now() - 5 * 60_000) });
  const seen = mk({ createdAt: new Date(Date.now() - 60 * 60_000), owner_seen_at: new Date() });
  const agreed = mk({ createdAt: new Date(Date.now() - 60 * 60_000), stage: 'agreed' });
  bookings.push(old, fresh2, seen, agreed);
  await remindUnanswered();
  assert.equal(notes.length, 1, 'faqat ko‘rilmagan va 30 daqiqadan oshgan');
  assert.equal(notes[0].kind, 'booking_unanswered');
  assert.ok(same(notes[0].booking_id, old._id) && same(notes[0].venue_id, VENUE));
  assert.ok(bookings[0].reminded_at, 'belgilandi');
  await remindUnanswered();
  assert.equal(notes.length, 1, 'ikkinchi marta eslatilmaydi');
});

test('muddat tugadi: egasiga xabar (kelishilgan bo‘lsa — "Avans muddati o‘tdi")', async () => {
  reset();
  const a = mk({ stage: 'new' }); const b = mk({ stage: 'agreed' }); bookings.push(a, b);
  await notifyExpired([a._id, b._id]);
  assert.equal(notes.length, 2);
  assert.match(notes.find((n) => same(n.booking_id, b._id))!.title, /Avans muddati/);
  assert.match(notes.find((n) => same(n.booking_id, a._id))!.title, /So‘rov muddati/);
  assert.ok(notes.every((n) => n.kind === 'booking_expired'));
});
