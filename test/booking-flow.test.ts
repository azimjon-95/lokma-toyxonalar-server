/*
 * Mijoz broni — egasi tomonidan boshqarish (so'rov → kelishildi → avans → tasdiqlandi / rad etildi).
 * Baza KERAK EMAS: sof mantiq va DTO. Ishga tushirish: npx tsx --test test/booking-flow.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Types } from 'mongoose';
import {
  advanceDeadline, allowedActions, assertAction, checkPayment, effectiveTotal, newBookingSms, ownerState,
  paidOf, stateLabel, suggestedAdvance, REJECT_REASONS, MAX_ADVANCE_DAYS,
} from '../src/modules/bookings/booking.flow.js';
import { bookingDto } from '../src/modules/owner/owner.inbox.js';
import { addDaysISO, todayISO } from '../src/lib/dates.js';

const NOW = new Date('2026-10-20T10:00:00+05:00');
const future = new Date(NOW.getTime() + 3600_000);
const past = new Date(NOW.getTime() - 3600_000);

test('holat: pending → new/agreed, muddati o‘tgan → expired', () => {
  assert.equal(ownerState({ status: 'pending', hold_until: future }, NOW), 'new');
  assert.equal(ownerState({ status: 'pending', stage: 'agreed', hold_until: future }, NOW), 'agreed');
  assert.equal(ownerState({ status: 'pending', hold_until: past }, NOW), 'expired', 'tozalash vazifasi hali ishlamagan bo‘lsa ham');
  assert.equal(ownerState({ status: 'pending' }, NOW), 'new', 'eski bron (stage yo‘q) — new');
});

test('holat: tasdiqlangan, yakunlangan, rad etilgan, muddati tugagan, bekor', () => {
  assert.equal(ownerState({ status: 'confirmed' }), 'confirmed');
  assert.equal(ownerState({ status: 'completed' }), 'completed');
  assert.equal(ownerState({ status: 'cancelled', rejected_at: new Date() }), 'rejected');
  assert.equal(ownerState({ status: 'cancelled', cancel_reason: 'expired' }), 'expired');
  assert.equal(ownerState({ status: 'cancelled', cancel_reason: 'customer' }), 'cancelled');
});

test('amallar: har holatda faqat mumkinlari', () => {
  assert.deepEqual(allowedActions('new'), ['seen', 'agree', 'reject', 'advance', 'confirm']);
  assert.ok(allowedActions('agreed').includes('advance') && !allowedActions('agreed').includes('seen'));
  assert.deepEqual(allowedActions('confirmed'), ['advance', 'cancel']);
  for (const s of ['completed', 'rejected', 'cancelled', 'expired'] as const) assert.deepEqual(allowedActions(s), [], `${s}: amal yo‘q`);
});

test('assertAction: mumkin bo‘lmasa tushunarli 409 xato', () => {
  assert.doesNotThrow(() => assertAction('new', 'reject'));
  assert.throws(() => assertAction('confirmed', 'reject'), /Bekor qilish/);
  assert.throws(() => assertAction('expired', 'advance'), /muddati tugagan/);
  assert.throws(() => assertAction('rejected', 'agree'), (e: { status?: number }) => e.status === 409);
});

test('avans muddati: standart 3 kun, kun oxiri Toshkent vaqti, chegaralar', () => {
  const today = todayISO(NOW);
  const d = advanceDeadline(undefined, NOW);
  assert.equal(d.dueISO, addDaysISO(today, 3));
  assert.equal(d.holdUntil.toISOString(), new Date(`${d.dueISO}T23:59:59+05:00`).toISOString());
  assert.equal(advanceDeadline(today, NOW).dueISO, today, 'bugun ham mumkin');
  assert.throws(() => advanceDeadline(addDaysISO(today, -1), NOW), /o‘tgan sana/);
  assert.throws(() => advanceDeadline(addDaysISO(today, MAX_ADVANCE_DAYS + 1), NOW), /30 kundan/);
  assert.doesNotThrow(() => advanceDeadline(addDaysISO(today, MAX_ADVANCE_DAYS), NOW));
});

test('to‘lov: to‘langan, qoldiq, tekshiruv', () => {
  assert.equal(paidOf([{ amount: 5000, kind: 'deposit' }, { amount: 2000, kind: 'payment' }, { amount: 1000, kind: 'refund' }]), 6000);
  assert.equal(paidOf([], 4000, true), 4000, 'eski tasdiqlangan bron: avans to‘langan');
  assert.equal(paidOf([], 4000, false), 0, 'tasdiqlanmagan bron: yo‘q');
  assert.equal(effectiveTotal(10_000_000, 9_000_000), 9_000_000, 'kelishilgan jami ustun');
  assert.equal(effectiveTotal(10_000_000, null), 10_000_000);
  assert.equal(effectiveTotal(10_000_000, 0), 10_000_000, '0 — kelishilmagan');
  assert.doesNotThrow(() => checkPayment(10_000_000, 0, 3_000_000));
  assert.doesNotThrow(() => checkPayment(10_000_000, 7_000_000, 3_000_000), 'aynan qoldiq');
  assert.throws(() => checkPayment(10_000_000, 7_000_000, 3_000_001), /qoldiqdan oshmasin/);
  assert.throws(() => checkPayment(10_000_000, 0, 0), /Summani kiriting/);
  assert.throws(() => checkPayment(10_000_000, 0, -5), /Summani kiriting/);
  assert.throws(() => checkPayment(10_000_000, 0, 1.5), /Summani kiriting/);
  assert.equal(suggestedAdvance(3_000_000, 10_000_000), 3_000_000);
  assert.equal(suggestedAdvance(3_000_000, 2_000_000), 2_000_000, 'jamidan oshmaydi');
});

test('rad etish sabablari va holat nomlari', () => {
  for (const k of ['busy', 'price', 'guests', 'no_answer', 'declined', 'other']) assert.ok(REJECT_REASONS[k], k);
  assert.equal(stateLabel('new'), 'Yangi so‘rov');
  assert.equal(stateLabel('agreed'), 'Kelishildi');
  assert.equal(stateLabel('confirmed'), 'Tasdiqlandi');
});

test('SMS: qisqa, lotin, kerakli ma’lumot bilan; xavfli belgilar tozalanadi', () => {
  const t = newBookingSms({ date: '2026-10-24', hall_name: 'Katta zal', guests: 300, customer_name: 'Ali <b>Valiyev</b>', customer_phone: '+998901112233' }, 'Kunduzgi');
  assert.match(t, /24\.10\.2026/);
  assert.match(t, /Katta zal/);
  assert.match(t, /300 mehmon/);
  assert.match(t, /\+998901112233/);
  assert.ok(!/[<>]/.test(t), 'teglar yo‘q');
  assert.ok(t.length <= 160, `bitta SMS (${t.length})`);
});

const base = () => ({
  _id: new Types.ObjectId(), number: 'TY-ABC12', status: 'pending', stage: 'new', venue_name: 'Navro‘z', hall_id: new Types.ObjectId(), hall_name: 'Katta zal',
  date: '2026-10-24', session: 'day', event_type: 'nikoh', guests: 300, menu: { name: 'Standart', price_per_guest: 250000 }, extras: [{ name: 'Fotograf', type: 'photo', price: 2000000 }],
  price_per_guest: 250000, venue_total: 75_000_000, total: 77_000_000, deposit: 15_400_000, customer_name: 'Ali Valiyev', customer_phone: '+998901112233',
  hold_until: new Date(Date.now() + 3600_000), createdAt: new Date(), payments: [], timeline: [{ at: new Date(), kind: 'created', text: 'Mijoz bron so‘rovini yubordi' }],
});

test('DTO: yangi so‘rov — to‘liq ma’lumot, avans taklifi, amallar', () => {
  const d = bookingDto(base() as never);
  assert.equal(d.state, 'new');
  assert.equal(d.state_label, 'Yangi so‘rov');
  assert.deepEqual(d.customer, { name: 'Ali Valiyev', phone: '+998901112233' });
  assert.equal(d.guests, 300);
  assert.equal(d.menu?.name, 'Standart');
  assert.equal(d.extras[0].name, 'Fotograf');
  assert.equal(d.total_effective, 77_000_000);
  assert.equal(d.paid, 0);
  assert.equal(d.balance, 77_000_000);
  assert.equal(d.deposit_suggested, 15_400_000);
  assert.deepEqual(d.actions, ['seen', 'agree', 'reject', 'advance', 'confirm']);
  assert.equal(d.timeline.length, 1);
});

test('DTO: kelishildi — kelishilgan jami qoldiqni o‘zgartiradi', () => {
  const d = bookingDto({ ...base(), stage: 'agreed', agreed_total: 70_000_000, agreed_note: 'Gul bezagi bepul', advance_due: new Date() } as never);
  assert.equal(d.state, 'agreed');
  assert.equal(d.total, 77_000_000);
  assert.equal(d.total_effective, 70_000_000);
  assert.equal(d.balance, 70_000_000);
  assert.equal(d.agreed_note, 'Gul bezagi bepul');
  assert.ok(!d.actions.includes('seen'));
});

test('DTO: tasdiqlangan — to‘lovlar, qoldiq, qo‘shimcha to‘lov va bekor qilish', () => {
  const d = bookingDto({ ...base(), status: 'confirmed', payments: [{ _id: new Types.ObjectId(), amount: 15_000_000, method: 'cash', kind: 'deposit', date: '2026-10-20', note: '' }] } as never);
  assert.equal(d.state, 'confirmed');
  assert.equal(d.paid, 15_000_000);
  assert.equal(d.balance, 62_000_000);
  assert.deepEqual(d.actions, ['advance', 'cancel']);
  assert.equal(d.payments[0].amount, 15_000_000);
});

test('DTO: eski tasdiqlangan bron (to‘lov yozuvi yo‘q) — avans to‘langan hisoblanadi', () => {
  const d = bookingDto({ ...base(), status: 'confirmed', payments: [] } as never);
  assert.equal(d.paid, 15_400_000);
  assert.equal(d.balance, 77_000_000 - 15_400_000);
});

test('DTO: rad etilgan — amal yo‘q, sabab ko‘rinadi', () => {
  const d = bookingDto({ ...base(), status: 'cancelled', rejected_at: new Date(), reject_reason: 'Narx bo‘yicha kelisha olmadik', cancelled_by: 'owner' } as never);
  assert.equal(d.state, 'rejected');
  assert.equal(d.state_label, 'Rad etildi');
  assert.deepEqual(d.actions, []);
  assert.equal(d.reject_reason, 'Narx bo‘yicha kelisha olmadik');
});

test('DTO: shaxsiy maydonlar chiqmaydi (payment_url, user_id, staff)', () => {
  const d = bookingDto({ ...base(), payment_url: 'https://x', user_id: new Types.ObjectId(), staff_ids: [new Types.ObjectId()] } as never) as Record<string, unknown>;
  for (const k of ['payment_url', 'user_id', 'staff_ids']) assert.ok(!(k in d), k);
});
