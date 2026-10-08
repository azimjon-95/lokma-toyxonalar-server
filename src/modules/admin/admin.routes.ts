import { SESSION_CODES, EVENT_TYPES, PRICING_MODES } from '../../lib/sessions.js';
import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { objectId, parse } from '../../lib/validate.js';
import { ISO_DATE } from '../../lib/dates.js';
import { notFound } from '../../lib/http-error.js';
import { requireAdmin } from '../auth/auth.middleware.js';
import { VenueModel } from '../venues/venue.model.js';
import { VendorModel } from '../vendors/vendor.model.js';
import { setManualSlot } from '../slots/slot.service.js';
import { adminListBookings, cancelBooking, confirmBooking } from '../bookings/booking.service.js';
import { BookingModel } from '../bookings/booking.model.js';
import { PaymentModel } from '../payments/payment.model.js';
import { recalcPaidUntil, subscriptionState } from '../payments/payment.service.js';
import { todayISO } from '../../lib/dates.js';
import { VenueAccountModel } from '../owner/owner.models.js';
import { hashPassword } from '../owner/password.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const eventType = z.enum(EVENT_TYPES);
const venueSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(2),
  district: z.string().min(2),
  address: z.string().default(''),
  phone: z.string().default(''),
  description: z.string().default(''),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  rating: z.number().min(0).max(5).default(0),
  reviews_count: z.number().int().min(0).default(0),
  photos: z.array(z.url()).default([]),
  parking_spots: z.number().int().min(0).default(0),
  amenities: z.array(z.string()).default([]),
  halls: z.array(z.object({ name: z.string(), capacity_min: z.number().int().positive(), capacity_max: z.number().int().positive() })).min(1),
  sessions: z.array(z.object({
    code: z.enum(SESSION_CODES),
    start_time: z.string().regex(/^\d{2}:\d{2}$/),
    end_time: z.string().regex(/^\d{2}:\d{2}$/),
    event_types: z.array(eventType).min(1),
    price_factor: z.number().positive(),
    min_guests: z.number().int().positive(),
    pricing_mode: z.enum(PRICING_MODES).default('per_guest'),
    fixed_price: z.number().int().nonnegative().default(0),
    note: z.string().max(200).default(''),
  })
    // Aniq narx tanlansa — narx kiritilishi shart
    .refine((s) => s.pricing_mode !== 'fixed' || s.fixed_price > 0, { message: 'Aniq narxni kiriting', path: ['fixed_price'] }))
    .min(1)
    .refine((list) => new Set(list.map((s) => s.code)).size === list.length, { message: 'Seanslar takrorlanmasin' }),
  menu_packages: z.array(z.object({ name: z.string(), items_text: z.string().default(''), price_per_guest: z.number().int().nonnegative() })).min(1),
  weekend_factor: z.number().min(1).max(3).default(1.15),
  deposit_percent: z.number().min(0).max(100).default(30),
  guests_min: z.number().int().positive().default(150),
  status: z.enum(['active', 'hidden']).default('active'),
  owner: z.object({
    name: z.string().max(120).default(''),
    phone: z.string().max(40).default(''),
    telegram: z.string().max(64).default(''),
    note: z.string().max(500).default(''),
  }).optional(),
  subscription: z.object({
    monthly_fee: z.number().int().nonnegative().default(0),
    billing_start: z.string().regex(/^(\d{4}-\d{2})?$/).default(''),
  }).optional(),
});

/*
 * PATCH uchun: faqat so'rovda HAQIQATAN kelgan maydonlar.
 * Zod 4 da `.partial()` ham `.default()` qiymatlarni qo'yadi — aks holda
 * { status } yuborilganda tavsif, rasmlar, mashinalar va h.k. standart
 * (bo'sh) qiymatga qaytib, ma'lumot o'chib ketardi.
 */
function onlyGiven<T extends Record<string, unknown>>(parsed: T, raw: unknown): Partial<T> {
  const keys = raw && typeof raw === 'object' ? Object.keys(raw as object) : [];
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => keys.includes(k))) as Partial<T>;
}

/** Ro'yxat qatoriga obuna holati qo'shiladi (admin jadvali uchun) */
const withSub = <T extends { subscription?: unknown }>(v: T) => ({
  ...v,
  subscription_state: subscriptionState(v.subscription as never),
});

adminRouter.get('/venues', async (req, res) => {
  const f = parse(z.object({
    status: z.enum(['active', 'hidden', 'blocked']).optional(),
    q: z.string().max(60).optional(),
  }), req.query);
  const q: Record<string, unknown> = {};
  if (f.status) q.status = f.status;
  if (f.q?.trim()) {
    const rx = new RegExp(f.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [{ name: rx }, { district: rx }, { 'owner.name': rx }, { 'owner.phone': rx }];
  }
  const rows = await VenueModel.find(q).sort({ name: 1 }).lean();
  res.json(rows.map(withSub));
});
adminRouter.get('/venues/:id', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const v = await VenueModel.findById(id).lean();
  if (!v) throw notFound('To‘yxona topilmadi');
  res.json(withSub(v));
});
adminRouter.post('/venues', async (req, res) => {
  const v = await VenueModel.create(parse(venueSchema, req.body));
  res.status(201).json(withSub(v.toObject()));
});
adminRouter.patch('/venues/:id', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const body = onlyGiven(parse(venueSchema.partial(), req.body), req.body);
  // Ichki obyektlar qisman yangilanadi (paid_until to'lovlardan hisoblanadi — tegilmaydi)
  const $set: Record<string, unknown> = { ...body };
  delete $set.owner; delete $set.subscription;
  const raw = (req.body ?? {}) as { owner?: object; subscription?: object };
  if (body.owner) for (const [k, val] of Object.entries(onlyGiven(body.owner, raw.owner))) $set[`owner.${k}`] = val;
  if (body.subscription) for (const [k, val] of Object.entries(onlyGiven(body.subscription, raw.subscription))) $set[`subscription.${k}`] = val;
  const v = await VenueModel.findByIdAndUpdate(id, { $set }, { returnDocument: 'after', runValidators: true }).lean();
  if (!v) throw notFound('To‘yxona topilmadi');
  res.json(withSub(v));
});

/** Bloklash: mijozlarga ko'rinmaydi, yangi bron qabul qilinmaydi. Mavjud bronlar saqlanadi. */
adminRouter.post('/venues/:id/block', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const { reason } = parse(z.object({ reason: z.string().min(2).max(300) }), req.body ?? {});
  const v = await VenueModel.findByIdAndUpdate(id, { $set: { status: 'blocked', block_reason: reason, blocked_at: new Date() } }, { returnDocument: 'after' }).lean();
  if (!v) throw notFound('To‘yxona topilmadi');
  res.json(withSub(v));
});
adminRouter.post('/venues/:id/unblock', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const v = await VenueModel.findByIdAndUpdate(id, { $set: { status: 'active', block_reason: '', blocked_at: null } }, { returnDocument: 'after' }).lean();
  if (!v) throw notFound('To‘yxona topilmadi');
  res.json(withSub(v));
});

/* ═══ OYLIK TO'LOVLAR ═══ */
adminRouter.get('/payments', async (req, res) => {
  const f = parse(z.object({
    venue_id: objectId.optional(),
    month: z.string().regex(/^\d{4}-\d{2}$/).optional(), // shu oyda qilingan to'lovlar
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }), req.query);
  const q: Record<string, unknown> = {};
  if (f.venue_id) q.venue_id = f.venue_id;
  if (f.month) {
    const [y, m] = f.month.split('-').map(Number);
    q.paid_at = { $gte: new Date(Date.UTC(y, m - 1, 1) - 5 * 3600_000), $lt: new Date(Date.UTC(y, m, 1) - 5 * 3600_000) };
  }
  res.json(await PaymentModel.find(q).sort({ paid_at: -1 }).limit(f.limit).lean());
});
adminRouter.post('/payments', async (req, res) => {
  const b = parse(z.object({
    venue_id: objectId,
    amount: z.number().int().positive(),
    period_from: z.string().regex(/^\d{4}-\d{2}$/),
    months: z.number().int().min(1).max(24).default(1),
    method: z.enum(['cash', 'card', 'transfer', 'click', 'payme', 'other']).default('cash'),
    paid_at: z.string().datetime().optional(),
    note: z.string().max(300).default(''),
    created_by: z.string().max(80).default(''),
  }), req.body);
  const venue = await VenueModel.findById(b.venue_id, { name: 1 }).lean();
  if (!venue) throw notFound('To‘yxona topilmadi');
  const p = await PaymentModel.create({ ...b, venue_name: venue.name, paid_at: b.paid_at ? new Date(b.paid_at) : new Date() });
  const paid_until = await recalcPaidUntil(venue._id);
  res.status(201).json({ payment: p.toObject(), paid_until });
});
adminRouter.delete('/payments/:id', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const p = await PaymentModel.findByIdAndDelete(id).lean();
  if (!p) throw notFound('To‘lov topilmadi');
  const paid_until = await recalcPaidUntil(p.venue_id);
  res.json({ ok: true, paid_until });
});

/** Obuna nazorati: barcha to'yxonalar holati (qarzdorlar birinchi) */
adminRouter.get('/subscriptions', async (_req, res) => {
  const today = todayISO();
  const rows = await VenueModel.find({}, { name: 1, district: 1, status: 1, owner: 1, subscription: 1 }).lean();
  const order: Record<string, number> = { overdue: 0, never: 1, due_soon: 2, paid: 3, free: 4 };
  const list = rows.map((v) => ({ ...v, subscription_state: subscriptionState(v.subscription as never, today) }))
    .sort((a, b) => order[a.subscription_state.state] - order[b.subscription_state.state] || String(a.name).localeCompare(String(b.name)));
  res.json(list);
});

/** Boshqaruv paneli raqamlari */
adminRouter.get('/stats', async (_req, res) => {
  const today = todayISO();
  const month = today.slice(0, 7);
  const [venues, vendors, byStatus, monthBookings, upcoming, monthPaid] = await Promise.all([
    VenueModel.find({}, { status: 1, subscription: 1 }).lean(),
    VendorModel.aggregate([{ $group: { _id: { type: '$type', blocked: '$blocked' }, n: { $sum: 1 } } }]),
    BookingModel.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    BookingModel.aggregate([
      { $match: { date: { $gte: `${month}-01`, $lte: `${month}-31` }, status: { $in: ['confirmed', 'completed'] } } },
      { $group: { _id: null, n: { $sum: 1 }, total: { $sum: '$total' } } },
    ]),
    BookingModel.countDocuments({ date: { $gte: today }, status: { $in: ['pending', 'confirmed'] } }),
    PaymentModel.aggregate([
      { $match: { paid_at: { $gte: new Date(`${month}-01T00:00:00+05:00`) } } },
      { $group: { _id: null, sum: { $sum: '$amount' }, n: { $sum: 1 } } },
    ]),
  ]);
  const subs = venues.map((v) => subscriptionState(v.subscription as never, today));
  const vcount = (type: string, blocked = false) => vendors.filter((x) => x._id.type === type && Boolean(x._id.blocked) === blocked).reduce((s, x) => s + x.n, 0);
  res.json({
    venues: {
      total: venues.length,
      active: venues.filter((v) => v.status === 'active').length,
      hidden: venues.filter((v) => v.status === 'hidden').length,
      blocked: venues.filter((v) => v.status === 'blocked').length,
    },
    subscriptions: {
      overdue: subs.filter((s) => s.state === 'overdue' || s.state === 'never').length,
      due_soon: subs.filter((s) => s.state === 'due_soon').length,
      debt_amount: subs.reduce((s, x) => s + x.debt_amount, 0),
      paid_this_month: monthPaid[0]?.sum ?? 0,
      payments_this_month: monthPaid[0]?.n ?? 0,
    },
    bookings: {
      by_status: Object.fromEntries(byStatus.map((x) => [x._id, x.n])),
      this_month: monthBookings[0]?.n ?? 0,
      this_month_total: monthBookings[0]?.total ?? 0,
      upcoming,
    },
    vendors: {
      video: vcount('video'), cortege: vcount('cortege'),
      blocked: vcount('video', true) + vcount('cortege', true),
    },
  });
});

const vendorSchema = z.object({
  type: z.enum(['video', 'cortege']),
  name: z.string().min(2),
  description: z.string().default(''),
  price: z.number().int().nonnegative(),
  photo: z.url().optional(),
  rating: z.number().min(0).max(5).optional(),
  venue_ids: z.array(objectId).default([]),
  active: z.boolean().default(true),
  contact_name: z.string().max(120).default(''),
  phone: z.string().max(40).default(''),
  telegram: z.string().max(64).default(''),
  district: z.string().max(80).default(''),
  experience_years: z.number().int().min(0).max(80).default(0),
  photos: z.array(z.url()).max(30).default([]),
  portfolio_urls: z.array(z.url()).max(20).default([]),
  note: z.string().max(1000).default(''),
  video: z.object({
    cameras: z.number().int().min(0).max(50).default(1),
    has_drone: z.boolean().default(false),
    equipment: z.string().max(500).default(''),
    delivery_days: z.number().int().min(0).max(365).default(0),
    services: z.array(z.enum(['video', 'foto', 'klip', 'love_story', 'jonli_efir', 'montaj'])).default([]),
  }).optional(),
  cars: z.array(z.object({
    model: z.string().min(1).max(60),
    color: z.string().max(30).default(''),
    year: z.number().int().min(1950).max(2100).optional(),
    count: z.number().int().min(1).max(100).default(1),
    price: z.number().int().nonnegative().default(0),
  })).max(50).default([]),
});
adminRouter.get('/vendors', async (req, res) => {
  const f = parse(z.object({ type: z.enum(['video', 'cortege']).optional() }), req.query);
  res.json(await VendorModel.find(f.type ? { type: f.type } : {}).sort({ type: 1, price: 1 }).lean());
});
adminRouter.get('/vendors/:id', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const v = await VendorModel.findById(id).lean();
  if (!v) throw notFound('Xizmat topilmadi');
  res.json(v);
});
/** Bloklash — mijozlarga taklif qilinmaydi (active=false), sababi saqlanadi */
adminRouter.post('/vendors/:id/block', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const { reason } = parse(z.object({ reason: z.string().min(2).max(300) }), req.body ?? {});
  const v = await VendorModel.findByIdAndUpdate(id, { $set: { blocked: true, block_reason: reason, active: false } }, { returnDocument: 'after' }).lean();
  if (!v) throw notFound('Xizmat topilmadi');
  res.json(v);
});
adminRouter.post('/vendors/:id/unblock', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const v = await VendorModel.findByIdAndUpdate(id, { $set: { blocked: false, block_reason: '', active: true } }, { returnDocument: 'after' }).lean();
  if (!v) throw notFound('Xizmat topilmadi');
  res.json(v);
});
/** O'chirish — faqat hech bir bronda ishlatilmagan bo'lsa (aks holda bloklang) */
adminRouter.delete('/vendors/:id', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const used = await BookingModel.exists({ 'extras.vendor_id': id });
  if (used) {
    res.status(409).json({ message: 'Bu xizmat bronlarda ishlatilgan — o‘chirib bo‘lmaydi, bloklang', code: 'in_use' });
    return;
  }
  const v = await VendorModel.findByIdAndDelete(id).lean();
  if (!v) throw notFound('Xizmat topilmadi');
  res.json({ ok: true });
});
adminRouter.post('/vendors', async (req, res) => {
  res.status(201).json(await VendorModel.create(parse(vendorSchema, req.body)));
});
adminRouter.patch('/vendors/:id', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const body = onlyGiven(parse(vendorSchema.partial(), req.body), req.body);
  const v = await VendorModel.findByIdAndUpdate(id, { $set: body }, { returnDocument: 'after', runValidators: true }).lean();
  if (!v) throw notFound('Xizmat topilmadi');
  res.json(v);
});

/** Seansni qo'lda yopish (ta'mir, oflayn mijoz) yoki ochish */
adminRouter.put('/slots', async (req, res) => {
  const b = parse(
    z.object({
      hall_id: objectId,
      date: z.string().regex(ISO_DATE),
      session: z.enum(SESSION_CODES),
      status: z.enum(['closed', 'booked', 'free']),
      note: z.string().max(200).optional(),
    }),
    req.body,
  );
  const venue = await VenueModel.findOne({ 'halls._id': b.hall_id }, { _id: 1 }).lean();
  if (!venue) throw notFound('Zal topilmadi');
  await setManualSlot({ venueId: venue._id, hallId: new Types.ObjectId(b.hall_id), date: b.date, session: b.session, status: b.status, note: b.note });
  res.json({ ok: true });
});

adminRouter.get('/bookings', async (req, res) => {
  const f = parse(
    z.object({
      status: z.enum(['pending', 'confirmed', 'cancelled', 'completed']).optional(),
      date: z.string().regex(ISO_DATE).optional(),
      from: z.string().regex(ISO_DATE).optional(),
      to: z.string().regex(ISO_DATE).optional(),
      q: z.string().max(60).optional(),
      venue_id: objectId.optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
    req.query,
  );
  res.json(await adminListBookings(f));
});
adminRouter.post('/bookings/:id/confirm', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  res.json(await confirmBooking(id));
});
adminRouter.post('/bookings/:id/cancel', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const { reason } = parse(z.object({ reason: z.string().max(200).default('admin') }), req.body ?? {});
  res.json(await cancelBooking(id, { admin: true }, reason));
});


/* ═══ TO'YXONA EGASI AKKAUNTI (LokmaGo admin paneli login sahifasi orqali kiradi) ═══ */
adminRouter.get('/venues/:id/account', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const a = await VenueAccountModel.findOne({ venue_id: id }, { login: 1, active: 1, last_login_at: 1, createdAt: 1 }).lean();
  res.json(a || null);
});
adminRouter.put('/venues/:id/account', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const b = parse(z.object({
    login: z.string().min(3).max(40).regex(/^[a-z0-9._-]+$/i, 'Login: lotin harf, raqam, . _ -'),
    password: z.string().min(6).max(100).optional(),
    active: z.boolean().default(true),
  }), req.body);
  const venue = await VenueModel.exists({ _id: id });
  if (!venue) throw notFound('To‘yxona topilmadi');
  const existing = await VenueAccountModel.findOne({ venue_id: id });
  if (!existing && !b.password) {
    res.status(422).json({ message: 'Yangi akkaunt uchun parol kiriting', code: 'validation' });
    return;
  }
  const $set: Record<string, unknown> = { login: b.login.toLowerCase(), active: b.active };
  if (b.password) $set.password_hash = await hashPassword(b.password);
  const a = await VenueAccountModel.findOneAndUpdate({ venue_id: id }, { $set, $setOnInsert: { venue_id: id } }, { upsert: true, returnDocument: 'after' }).lean();
  res.json({ login: a!.login, active: a!.active, last_login_at: a!.last_login_at ?? null });
});
