import { Router, type NextFunction, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { objectId, parse } from '../../lib/validate.js';
import { ISO_DATE, monthDays, todayISO, SESSION_ORDER } from '../../lib/dates.js';
import { conflict, forbidden, notFound, unauthorized } from '../../lib/http-error.js';
import { SESSION_CODES, EVENT_TYPES, PRICING_MODES, SESSION_LABELS, type SessionCodeAll } from '../../lib/sessions.js';
import { requireAdmin } from '../auth/auth.middleware.js';
import { VenueModel } from '../venues/venue.model.js';
import { SlotModel } from '../slots/slot.model.js';
import { BookingModel } from '../bookings/booking.model.js';
import {
  VenueAccountModel, ReservationModel, TransactionModel, EmployeeModel,
  PAY_METHODS, INCOME_CATEGORIES, EXPENSE_CATEGORIES,
} from './owner.models.js';
import { hashPassword, verifyPassword } from './password.js';

/*
 * ═══ TO'YXONA EGASI — CRM API ═══
 *
 * Kim chaqiradi: FAQAT lakmago-server (X-Admin-Key bilan). Egasi LokmaGo
 * admin paneliga o'z login/paroli bilan kiradi; lakmago-server token
 * beradi va har so'rovga `X-Venue-Id` sarlavhasini TOKENDAN qo'yadi.
 * Brauzer bu sarlavhani o'zgartira olmaydi (kalit unda yo'q).
 *
 * Har so'rovda tekshiriladi: to'yxona mavjud, akkaunt faol, to'yxona
 * bloklanmagan — admin bloklasa yoki akkauntni o'chirsa, egasi darhol
 * chiqarib yuboriladi (token muddati tugashini kutmasdan).
 */
export const ownerRouter = Router();
export const internalRouter = Router();

type OwnerReq = Request & { venueId?: Types.ObjectId; venue?: { _id: Types.ObjectId; name: string; halls: { _id: Types.ObjectId; name: string }[]; sessions: { code: string }[] } };

/* ── Ichki: login tekshiruvi (lakmago-server chaqiradi) ── */
internalRouter.use(requireAdmin);
internalRouter.post('/owner-login', async (req, res) => {
  const b = parse(z.object({ login: z.string().min(1).max(64), password: z.string().min(1).max(200) }), req.body);
  const acc = await VenueAccountModel.findOne({ login: b.login.toLowerCase().trim() });
  // Bir xil javob — login mavjudligini oshkor qilmaymiz
  if (!acc || !(await verifyPassword(b.password, acc.password_hash))) throw unauthorized('Login yoki parol xato');
  if (!acc.active) throw forbidden('Akkaunt o‘chirilgan. Administrator bilan bog‘laning.');
  const venue = await VenueModel.findById(acc.venue_id, { name: 1, status: 1, block_reason: 1 }).lean();
  if (!venue) throw notFound('To‘yxona topilmadi');
  if (venue.status === 'blocked') throw forbidden(`To‘yxona bloklangan${venue.block_reason ? `: ${venue.block_reason}` : ''}`);
  acc.last_login_at = new Date();
  await acc.save();
  res.json({ venue_id: String(venue._id), venue_name: venue.name, login: acc.login });
});

/* ── Egasi API: kalit + to'yxona ── */
ownerRouter.use(requireAdmin);
ownerRouter.use(async (req: OwnerReq, _res: Response, next: NextFunction) => {
  const raw = String(req.headers['x-venue-id'] ?? '');
  if (!/^[a-f0-9]{24}$/i.test(raw)) throw unauthorized('To‘yxona aniqlanmadi');
  const [venue, acc] = await Promise.all([
    VenueModel.findById(raw, { name: 1, status: 1, block_reason: 1, halls: 1, sessions: 1, district: 1, phone: 1, subscription: 1 }).lean(),
    VenueAccountModel.findOne({ venue_id: raw }, { active: 1 }).lean(),
  ]);
  if (!venue || !acc?.active) throw unauthorized('Akkaunt faol emas');
  if (venue.status === 'blocked') throw forbidden(`To‘yxona bloklangan${venue.block_reason ? `: ${venue.block_reason}` : ''}`);
  req.venueId = venue._id as Types.ObjectId;
  req.venue = venue as never;
  next();
});

const vid = (req: Request) => (req as OwnerReq).venueId!;

ownerRouter.get('/me', async (req: OwnerReq, res) => {
  const v = await VenueModel.findById(req.venueId).lean();
  res.json({
    venue: {
      _id: v!._id, name: v!.name, district: v!.district, phone: v!.phone, status: v!.status,
      halls: v!.halls, sessions: v!.sessions, menu_packages: v!.menu_packages,
      subscription: v!.subscription,
    },
    session_labels: SESSION_LABELS,
  });
});

/* ═══ KALENDAR ═══
 * Bir oy: har kun × zal × seans — holat va qisqa ma'lumot.
 * Manbalar: egasi bronlari (Reservation), ilova bronlari (Booking), qo'lda yopilgan slotlar.
 */
ownerRouter.get('/calendar', async (req: OwnerReq, res) => {
  const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }), req.query);
  const days = monthDays(month);
  const from = days[0]; const to = days[days.length - 1];
  const [resv, bookings, slots] = await Promise.all([
    ReservationModel.find({ venue_id: req.venueId, date: { $gte: from, $lte: to } }).lean(),
    BookingModel.find({ venue_id: req.venueId, date: { $gte: from, $lte: to }, status: { $in: ['pending', 'confirmed', 'completed'] } },
      { number: 1, status: 1, hall_id: 1, date: 1, session: 1, customer_name: 1, customer_phone: 1, guests: 1, total: 1, deposit: 1, event_type: 1, hold_until: 1 }).lean(),
    SlotModel.find({ venue_id: req.venueId, date: { $gte: from, $lte: to }, status: 'closed', reservation_id: { $exists: false } }, { hall_id: 1, date: 1, session: 1, note: 1 }).lean(),
  ]);
  const now = new Date();
  const entries = [
    ...resv.map((r) => ({
      kind: 'reservation' as const, id: String(r._id), hall_id: String(r.hall_id), date: r.date, session: r.session,
      status: r.status, title: r.customer_name || r.description?.slice(0, 40) || '', phone: r.customer_phone, guests: r.guests,
      total: r.total_price, paid: (r.payments || []).reduce((s, p) => s + (p.kind === 'refund' ? -p.amount : p.amount), 0),
      event_type: r.event_type,
    })),
    ...bookings
      .filter((b) => b.status !== 'pending' || (b.hold_until && b.hold_until > now))
      .map((b) => ({
        kind: 'booking' as const, id: String(b._id), hall_id: String(b.hall_id), date: b.date, session: b.session,
        status: b.status === 'pending' ? 'tentative' : 'booked', title: b.customer_name, phone: b.customer_phone, guests: b.guests,
        total: b.total, paid: b.status === 'confirmed' || b.status === 'completed' ? b.deposit : 0, event_type: b.event_type, number: b.number,
      })),
    ...slots.map((s) => ({
      kind: 'closed' as const, id: String(s._id), hall_id: String(s.hall_id), date: s.date, session: s.session,
      status: 'closed', title: s.note || 'Yopiq', phone: '', guests: 0, total: 0, paid: 0,
    })),
  ];
  res.json({
    month, today: todayISO(),
    halls: req.venue!.halls.map((h) => ({ _id: String(h._id), name: h.name })),
    sessions: SESSION_ORDER.filter((c) => req.venue!.sessions.some((s) => s.code === c)),
    entries,
  });
});

/* ═══ EGASI BRONLARI ═══ */
const paymentIn = z.object({
  amount: z.number().int().positive(),
  method: z.enum(PAY_METHODS).default('cash'),
  kind: z.enum(['deposit', 'payment', 'refund']).default('deposit'),
  date: z.string().regex(ISO_DATE),
  note: z.string().max(200).default(''),
});
const reservationIn = z.object({
  hall_id: objectId,
  date: z.string().regex(ISO_DATE),
  session: z.enum(SESSION_CODES),
  status: z.enum(['booked', 'tentative', 'closed']).default('booked'),
  event_type: z.enum(EVENT_TYPES).optional(),
  customer_name: z.string().max(120).default(''),
  customer_phone: z.string().max(40).default(''),
  guests: z.number().int().min(0).max(100000).default(0),
  pricing_mode: z.enum(PRICING_MODES).default('per_guest'),
  price_per_guest: z.number().int().min(0).default(0),
  total_price: z.number().int().min(0).default(0),
  payments: z.array(paymentIn).max(50).default([]),
  description: z.string().max(2000).default(''),
});

/** Seans tanlangan zal/sana uchun bo'shmi — ilova broni yoki boshqa yozuv bo'lsa 409 */
async function claimSlot(venueId: Types.ObjectId, hallId: Types.ObjectId, date: string, session: SessionCodeAll, reservationId: Types.ObjectId, note: string, status: 'booked' | 'closed') {
  const filter = { hall_id: hallId, date, session };
  const existing = await SlotModel.findOne(filter).lean();
  if (existing) {
    const liveHold = existing.status === 'hold' && existing.hold_until && existing.hold_until > new Date();
    if (existing.booking_id && (existing.status === 'booked' || liveHold)) throw conflict('Bu seansda ilova orqali bron bor', 'has_booking');
    if (existing.reservation_id && String(existing.reservation_id) !== String(reservationId)) throw conflict('Bu seans allaqachon band', 'slot_taken');
  }
  await SlotModel.updateOne(
    filter,
    { $set: { venue_id: venueId, status, note, reservation_id: reservationId }, $unset: { hold_until: 1, booking_id: 1 } },
    { upsert: true },
  );
}
async function releaseSlot(hallId: Types.ObjectId, date: string, session: SessionCodeAll, reservationId: Types.ObjectId) {
  await SlotModel.deleteOne({ hall_id: hallId, date, session, reservation_id: reservationId });
}

function checkHall(req: OwnerReq, hallId: string) {
  const hall = req.venue!.halls.find((h) => String(h._id) === hallId);
  if (!hall) throw notFound('Zal topilmadi');
  return hall;
}

ownerRouter.get('/reservations', async (req: OwnerReq, res) => {
  const f = parse(z.object({
    from: z.string().regex(ISO_DATE).optional(), to: z.string().regex(ISO_DATE).optional(),
    q: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(500).default(200),
  }), req.query);
  const q: Record<string, unknown> = { venue_id: req.venueId };
  if (f.from || f.to) q.date = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) };
  if (f.q?.trim()) {
    const rx = new RegExp(f.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [{ customer_name: rx }, { customer_phone: rx }, { description: rx }];
  }
  res.json(await ReservationModel.find(q).sort({ date: 1, session: 1 }).limit(f.limit).lean());
});
ownerRouter.get('/reservations/:id', async (req: OwnerReq, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const r = await ReservationModel.findOne({ _id: id, venue_id: req.venueId }).lean();
  if (!r) throw notFound('Bron topilmadi');
  res.json(r);
});
/** Ilova orqali kelgan bron (faqat ko'rish) */
ownerRouter.get('/bookings/:id', async (req: OwnerReq, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const b = await BookingModel.findOne({ _id: id, venue_id: req.venueId }).lean();
  if (!b) throw notFound('Bron topilmadi');
  res.json(b);
});

ownerRouter.post('/reservations', async (req: OwnerReq, res) => {
  const b = parse(reservationIn, req.body);
  const hall = checkHall(req, b.hall_id);
  if (!req.venue!.sessions.some((s) => s.code === b.session)) throw notFound('Bu seans yoqilmagan');
  const doc = new ReservationModel({ ...b, venue_id: req.venueId, hall_name: hall.name });
  await claimSlot(req.venueId!, new Types.ObjectId(b.hall_id), b.date, b.session, doc._id as Types.ObjectId,
    b.customer_name || b.description.slice(0, 60), b.status === 'closed' ? 'closed' : 'booked');
  try {
    await doc.save();
  } catch (e) {
    await releaseSlot(new Types.ObjectId(b.hall_id), b.date, b.session, doc._id as Types.ObjectId);
    if ((e as { code?: number }).code === 11000) throw conflict('Bu seans allaqachon band', 'slot_taken');
    throw e;
  }
  res.status(201).json(doc.toObject());
});

ownerRouter.patch('/reservations/:id', async (req: OwnerReq, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const r = await ReservationModel.findOne({ _id: id, venue_id: req.venueId });
  if (!r) throw notFound('Bron topilmadi');
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const parsed = parse(reservationIn.partial(), raw);
  const b = Object.fromEntries(Object.entries(parsed).filter(([k]) => k in raw)) as Partial<z.infer<typeof reservationIn>>;
  const moved = (b.hall_id && b.hall_id !== String(r.hall_id)) || (b.date && b.date !== r.date) || (b.session && b.session !== r.session);
  const old = { hall: r.hall_id as Types.ObjectId, date: r.date, session: r.session };
  if (b.hall_id) { const hall = checkHall(req, b.hall_id); r.hall_name = hall.name; }
  Object.assign(r, b);
  const status = r.status === 'closed' ? 'closed' : 'booked';
  // Seans ko'chirilsa — yangisini band qilib, eskisini bo'shatamiz (shu tartibda: band bo'lsa hech narsa o'zgarmaydi)
  await claimSlot(req.venueId!, r.hall_id as Types.ObjectId, r.date, r.session, r._id as Types.ObjectId, r.customer_name || (r.description || '').slice(0, 60), status);
  try {
    await r.save();
  } catch (e) {
    if (moved) await releaseSlot(r.hall_id as Types.ObjectId, r.date, r.session, r._id as Types.ObjectId);
    if ((e as { code?: number }).code === 11000) throw conflict('Bu seans allaqachon band', 'slot_taken');
    throw e;
  }
  if (moved) await releaseSlot(old.hall, old.date, old.session, r._id as Types.ObjectId);
  res.json(r.toObject());
});

ownerRouter.delete('/reservations/:id', async (req: OwnerReq, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const r = await ReservationModel.findOneAndDelete({ _id: id, venue_id: req.venueId }).lean();
  if (!r) throw notFound('Bron topilmadi');
  await releaseSlot(r.hall_id as Types.ObjectId, r.date, r.session, r._id as Types.ObjectId);
  res.json({ ok: true });
});

/* ═══ KIRIM-CHIQIM ═══ */
const monthRange = (m: string) => ({ $gte: `${m}-01`, $lte: `${m}-31` });

ownerRouter.get('/finance/summary', async (req: OwnerReq, res) => {
  const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }), req.query);
  const range = monthRange(month);
  const [tx, resvPays, events, bookingIncome] = await Promise.all([
    TransactionModel.aggregate([
      { $match: { venue_id: req.venueId, date: range } },
      { $group: { _id: { type: '$type', category: '$category' }, sum: { $sum: '$amount' }, n: { $sum: 1 } } },
    ]),
    ReservationModel.aggregate([
      { $match: { venue_id: req.venueId } },
      { $unwind: '$payments' },
      { $match: { 'payments.date': range } },
      { $group: { _id: '$payments.kind', sum: { $sum: '$payments.amount' } } },
    ]),
    ReservationModel.aggregate([
      { $match: { venue_id: req.venueId, date: range, status: { $ne: 'closed' } } },
      { $group: { _id: null, n: { $sum: 1 }, total: { $sum: '$total_price' } } },
    ]),
    BookingModel.aggregate([
      { $match: { venue_id: req.venueId, date: range, status: { $in: ['confirmed', 'completed'] } } },
      { $group: { _id: null, n: { $sum: 1 }, deposit: { $sum: '$deposit' } } },
    ]),
  ]);
  const pay = Object.fromEntries(resvPays.map((x) => [x._id, x.sum]));
  const reservationIncome = (pay.deposit || 0) + (pay.payment || 0) - (pay.refund || 0);
  const income = tx.filter((x) => x._id.type === 'income');
  const expense = tx.filter((x) => x._id.type === 'expense');
  const otherIncome = income.reduce((s, x) => s + x.sum, 0);
  const expenseTotal = expense.reduce((s, x) => s + x.sum, 0);
  res.json({
    month,
    income: {
      reservations: reservationIncome,
      other: otherIncome,
      total: reservationIncome + otherIncome,
      by_category: Object.fromEntries(income.map((x) => [x._id.category, x.sum])),
    },
    expense: { total: expenseTotal, by_category: Object.fromEntries(expense.map((x) => [x._id.category, x.sum])) },
    net: reservationIncome + otherIncome - expenseTotal,
    events: { count: (events[0]?.n ?? 0) + (bookingIncome[0]?.n ?? 0), contracted: events[0]?.total ?? 0 },
    app_bookings: { count: bookingIncome[0]?.n ?? 0, deposits: bookingIncome[0]?.deposit ?? 0 },
  });
});

const txIn = z.object({
  type: z.enum(['income', 'expense']),
  category: z.string().min(1).max(40),
  amount: z.number().int().positive(),
  date: z.string().regex(ISO_DATE),
  method: z.enum(PAY_METHODS).default('cash'),
  note: z.string().max(300).default(''),
  employee_id: objectId.optional(),
}).refine((t) => (t.type === 'income' ? (INCOME_CATEGORIES as readonly string[]) : (EXPENSE_CATEGORIES as readonly string[])).includes(t.category), {
  message: 'Kategoriya noto‘g‘ri', path: ['category'],
});

ownerRouter.get('/transactions', async (req: OwnerReq, res) => {
  const f = parse(z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    type: z.enum(['income', 'expense']).optional(),
    employee_id: objectId.optional(),
  }), req.query);
  const q: Record<string, unknown> = { venue_id: req.venueId };
  if (f.month) q.date = monthRange(f.month);
  if (f.type) q.type = f.type;
  if (f.employee_id) q.employee_id = f.employee_id;
  res.json(await TransactionModel.find(q).sort({ date: -1, createdAt: -1 }).limit(500).lean());
});
ownerRouter.post('/transactions', async (req: OwnerReq, res) => {
  const b = parse(txIn, req.body);
  let employee_name: string | undefined;
  if (b.employee_id) {
    const e = await EmployeeModel.findOne({ _id: b.employee_id, venue_id: req.venueId }, { name: 1 }).lean();
    if (!e) throw notFound('Ishchi topilmadi');
    employee_name = e.name;
  }
  res.status(201).json(await TransactionModel.create({ ...b, venue_id: req.venueId, employee_name }));
});
ownerRouter.delete('/transactions/:id', async (req: OwnerReq, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const t = await TransactionModel.findOneAndDelete({ _id: id, venue_id: req.venueId }).lean();
  if (!t) throw notFound('Yozuv topilmadi');
  res.json({ ok: true });
});

/* ═══ ISHCHILAR ═══ */
const empIn = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().max(40).default(''),
  position: z.string().max(80).default(''),
  pay_type: z.enum(['daily', 'monthly', 'per_event']).default('monthly'),
  rate: z.number().int().min(0).default(0),
  hired_at: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).default(''),
  note: z.string().max(500).default(''),
  active: z.boolean().default(true),
});
ownerRouter.get('/employees', async (req: OwnerReq, res) => {
  const month = todayISO().slice(0, 7);
  const [list, paid] = await Promise.all([
    EmployeeModel.find({ venue_id: req.venueId }).sort({ active: -1, name: 1 }).lean(),
    TransactionModel.aggregate([
      { $match: { venue_id: req.venueId, type: 'expense', category: 'ish_haqi', date: monthRange(month), employee_id: { $exists: true } } },
      { $group: { _id: '$employee_id', sum: { $sum: '$amount' } } },
    ]),
  ]);
  const map = new Map(paid.map((p) => [String(p._id), p.sum]));
  res.json(list.map((e) => ({ ...e, paid_this_month: map.get(String(e._id)) || 0 })));
});
ownerRouter.post('/employees', async (req: OwnerReq, res) => {
  res.status(201).json(await EmployeeModel.create({ ...parse(empIn, req.body), venue_id: req.venueId }));
});
ownerRouter.patch('/employees/:id', async (req: OwnerReq, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const b = Object.fromEntries(Object.entries(parse(empIn.partial(), raw)).filter(([k]) => k in raw));
  const e = await EmployeeModel.findOneAndUpdate({ _id: id, venue_id: req.venueId }, { $set: b }, { returnDocument: 'after', runValidators: true }).lean();
  if (!e) throw notFound('Ishchi topilmadi');
  res.json(e);
});
