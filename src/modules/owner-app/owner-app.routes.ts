import { Router } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ISO_DATE, ISO_MONTH, monthDays, todayISO } from '../../lib/dates.js';
import { badRequest, conflict } from '../../lib/http-error.js';
import { normalizePhone } from '../../lib/phone.js';
import { SESSION_CODES, EVENT_TYPES, PRICING_MODES } from '../../lib/sessions.js';
import { objectId, parse } from '../../lib/validate.js';
import { logger } from '../../infrastructure/logger.js';
import { SlotModel } from '../slots/slot.model.js';
import { PAY_METHODS } from '../owner/owner.models.js';
import { applicationPrefix, assertOwnedPublicId, createUploadTicket, imageUrl, requireCloudinary, verifyAsset } from '../cloudinary/cloudinary.service.js';
import { VenueApplicationModel } from './owner-app.models.js';
import { authPublicRouter, authSecuredRouter } from './owner-app.auth.routes.js';
import { ctx, ownerAppAuth, requireOwnerRole } from './owner-app.auth.js';
import { OWNER_STATUSES } from './owner-app.dto.js';
import * as B from './owner-app.bookings.js';
import * as C from './owner-app.catalog.js';
import * as F from './owner-app.finance.js';

/*
 * ═══ TO'YXONA EGASI / XODIM MOBIL ILOVASI — API ═══  (/api/owner-app)
 *
 * Alohida yuza: ilova (lokma-toyxona-owner) to'g'ridan-to'g'ri shu serverga ulanadi, token bilan.
 * `/api/owner` (X-Admin-Key, LokmaGo admin paneli) bilan BIR XIL ma'lumot bazasi va seans mantig'i,
 * lekin kirish va javob shakli ilova uchun mos.
 *
 * Rollar: owner — hamma narsa; staff — bronlarni ko'radi va yangisini yaratadi, PUL KO'RMAYDI
 * (pul maydonlari javobdan umuman olib tashlanadi).
 */
export const ownerAppRouter = Router();

/* ── Ommaviy (token kerak emas) ── */
ownerAppRouter.use('/auth', authPublicRouter);

const publicLimiter = (limit: number, windowMs: number) =>
  rateLimit({
    windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
    message: { message: 'Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.', code: 'rate_limited' },
    skip: () => env.NODE_ENV === 'test' && process.env.OWNER_APP_RATE_LIMIT_ON !== '1',
  });

/** Ariza rasmlari uchun yuklash chiptasi (ro'yxatdan o'tmagan foydalanuvchi) */
ownerAppRouter.post('/applications/uploads/sign', publicLimiter(30, 60 * 60_000), (_req, res) => {
  res.json(createUploadTicket(applicationPrefix(), requireCloudinary()));
});

const applicationIn = z.object({
  name: z.string().trim().min(2).max(120),
  address: z.string().trim().min(3).max(300),
  phone: z.string().min(9).max(20),
  halls: z.number().int().min(1).max(20),
  capacity: z.number().int().min(1).max(20000),
  services: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  /** Cloudinary public_id'lar (ariza papkasidan) */
  photos: z.array(z.string().min(5).max(200)).max(8).default([]),
  price_from: z.number().int().min(0).optional(),
  price_to: z.number().int().min(0).optional(),
  notes: z.string().max(2000).default(''),
});

ownerAppRouter.post('/applications', publicLimiter(5, 60 * 60_000), async (req, res) => {
  const b = parse(applicationIn, req.body);
  const phone = normalizePhone(b.phone);
  if (!phone) throw badRequest('Telefon raqamini to‘liq kiriting');
  if (b.price_from && b.price_to && b.price_to < b.price_from) throw badRequest('Narx oralig‘i noto‘g‘ri');
  // Takroriy yuborish (bir telefondan 24 soat ichida) — yangi yozuv ochmaymiz
  const dup = await VenueApplicationModel.findOne({ phone, status: 'new', createdAt: { $gte: new Date(Date.now() - 24 * 3600_000) } }, { _id: 1 }).lean();
  if (dup) return void res.status(200).json({ ok: true, id: String(dup._id), duplicate: true });
  const photos: { public_id: string; url: string }[] = [];
  for (const id of b.photos) {
    assertOwnedPublicId(id, applicationPrefix());
    const a = await verifyAsset(id);
    photos.push({ public_id: id, url: imageUrl({ public_id: id, version: a.version }, 'large') });
  }
  const doc = await VenueApplicationModel.create({ ...b, phone, photos, ip: req.ip ?? '' });
  logger.info('Yangi to‘yxona arizasi', { name: b.name, phone });
  res.status(201).json({ ok: true, id: String(doc._id) });
});

/* ── Himoyalangan (Bearer token) ── */
ownerAppRouter.use(authSecuredRouter); // DELETE /account
ownerAppRouter.use(ownerAppAuth);

ownerAppRouter.get('/me', async (req, res) => res.json(await C.meDto(ctx(req))));

/* ═══ BRONLAR ═══ */
const hhmm = z.string().regex(/^(\d{2}:\d{2})?$/);
const bookingFields = {
  hall_id: objectId,
  date: z.string().regex(ISO_DATE),
  session: z.enum(SESSION_CODES),
  event_type: z.enum(EVENT_TYPES),
  customer_name: z.string().trim().min(2, 'Mijoz ismini kiriting').max(120),
  customer_phone: z.string().min(9).max(20),
  guests: z.number().int().min(1, 'Mehmonlar sonini kiriting').max(100000),
  menu_id: objectId.optional(),
  pricing_mode: z.enum(PRICING_MODES).optional(),
  price_per_guest: z.number().int().min(0).optional(),
  total: z.number().int().min(0),
  address: z.string().max(300).optional(),
  notes: z.string().max(2000).optional(),
  start_time: hhmm.optional(),
  end_time: hhmm.optional(),
  stage: z.enum(['pending', 'deposit', 'confirmed']).optional(),
};
const bookingIn = z.object(bookingFields);
const bookingPatch = z.object(bookingFields).partial().omit({ stage: true });

ownerAppRouter.get('/bookings', async (req, res) => {
  const f = parse(z.object({
    from: z.string().regex(ISO_DATE).optional(), to: z.string().regex(ISO_DATE).optional(),
    q: z.string().max(60).optional(), status: z.enum(OWNER_STATUSES as [string, ...string[]]).optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(1000),
  }), req.query);
  res.json(await B.listBookings(ctx(req), f as B.ListFilter));
});

ownerAppRouter.post('/bookings/quote', async (req, res) => {
  const b = parse(z.object({ hall_id: objectId, date: z.string().regex(ISO_DATE), session: z.enum(SESSION_CODES), guests: z.number().int().min(0).max(100000), menu_id: objectId.optional() }), req.body);
  res.json(await B.quoteFor(ctx(req), b));
});

ownerAppRouter.get('/bookings/availability', async (req, res) => {
  const { date } = parse(z.object({ date: z.string().regex(ISO_DATE) }), req.query);
  res.json(await B.availability(ctx(req), date));
});

ownerAppRouter.post('/bookings', async (req, res) => {
  res.status(201).json(await B.createBooking(ctx(req), parse(bookingIn, req.body) as B.BookingInput));
});

ownerAppRouter.get('/bookings/:id', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  res.json(await B.getBooking(ctx(req), id));
});

ownerAppRouter.patch('/bookings/:id', requireOwnerRole, async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const parsed = parse(bookingPatch, raw);
  // faqat so'rovda kelgan maydonlar (zod default/undefined qiymatlarni qo'shmasin)
  const patch = Object.fromEntries(Object.entries(parsed).filter(([k]) => k in raw)) as Partial<B.BookingInput>;
  res.json(await B.updateBooking(ctx(req), id, patch));
});

ownerAppRouter.post('/bookings/:id/status', requireOwnerRole, async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const { status } = parse(z.object({ status: z.enum(OWNER_STATUSES as [string, ...string[]]) }), req.body);
  res.json(await B.changeStatus(ctx(req), id, status as never));
});

ownerAppRouter.post('/bookings/:id/payments', requireOwnerRole, async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const b = parse(z.object({
    kind: z.enum(['deposit', 'payment', 'refund']), amount: z.number().int().positive('Summani kiriting'),
    method: z.enum(PAY_METHODS).default('cash'), date: z.string().regex(ISO_DATE).optional(), note: z.string().max(200).optional(),
  }), req.body);
  res.status(201).json(await B.addPayment(ctx(req), id, b));
});

ownerAppRouter.put('/bookings/:id/staff', requireOwnerRole, async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const { employee_ids } = parse(z.object({ employee_ids: z.array(objectId).max(100) }), req.body);
  res.json(await B.assignStaff(ctx(req), id, employee_ids));
});

/* ═══ KALENDAR (oy) ═══ */
ownerAppRouter.get('/calendar', async (req, res) => {
  const { month } = parse(z.object({ month: z.string().regex(ISO_MONTH, 'Format: YYYY-MM') }), req.query);
  const days = monthDays(month);
  const c = ctx(req);
  const [bookings, closed] = await Promise.all([
    B.listBookings(c, { from: days[0], to: days[days.length - 1], limit: 2000 }),
    SlotModel.find({ venue_id: c.venueId, date: { $gte: days[0], $lte: days[days.length - 1] }, status: 'closed' }, { hall_id: 1, date: 1, session: 1, note: 1, reservation_id: 1 }).lean(),
  ]);
  res.json({
    month, today: todayISO(),
    bookings: bookings.filter((b) => b.status !== 'cancelled'),
    // Yopiq seanslar (ta'mir va h.k.) — egasi bronlari "closed" holatida ham slotda turadi, ular alohida emas
    closed: closed.filter((s) => !s.reservation_id).map((s) => ({ hall_id: String(s.hall_id), date: s.date, session: s.session, note: s.note ?? '' })),
  });
});

/* ═══ MIJOZLAR ═══ */
ownerAppRouter.get('/clients', async (req, res) => {
  const { q } = parse(z.object({ q: z.string().max(60).optional() }), req.query);
  res.json(await B.listClients(ctx(req), q));
});

/* ═══ MENYU VA TAOMLAR (o'qish — hamma; yozish — egasi) ═══ */
const menuIn = z.object({
  name: z.string().trim().min(2, 'Menyu nomini kiriting').max(60),
  price_per_person: z.number().int().min(1, 'Narxni kiriting').max(100_000_000),
  min_guests: z.number().int().min(0).max(5000).optional(),
  dishes: z.array(z.string().trim().min(1).max(80)).max(60).optional(),
  photo_public_id: z.string().min(5).max(200).nullable().optional(),
});
ownerAppRouter.get('/menus', async (req, res) => res.json(await C.listMenus(ctx(req))));
ownerAppRouter.post('/menus', requireOwnerRole, async (req, res) => {
  const b = parse(menuIn, req.body);
  if (!b.dishes?.length) throw badRequest('Kamida bitta taom qo‘shing');
  res.status(201).json(await C.createMenu(ctx(req), b as C.MenuInput));
});
ownerAppRouter.patch('/menus/:id', requireOwnerRole, async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const p = Object.fromEntries(Object.entries(parse(menuIn.partial(), raw)).filter(([k]) => k in raw));
  res.json(await C.updateMenu(ctx(req), id, p as Partial<C.MenuInput>));
});
ownerAppRouter.delete('/menus/:id', requireOwnerRole, async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  res.json(await C.deleteMenu(ctx(req), id));
});

ownerAppRouter.get('/dishes', async (req, res) => res.json(await C.listDishes(ctx(req))));
ownerAppRouter.post('/dishes', requireOwnerRole, async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(80), photo_public_id: z.string().min(5).max(200).optional() }), req.body);
  res.status(201).json(await C.createDish(ctx(req), b.name, b.photo_public_id));
});
ownerAppRouter.patch('/dishes/:id', requireOwnerRole, async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const p = Object.fromEntries(Object.entries(parse(z.object({ name: z.string().trim().min(2).max(80), photo_public_id: z.string().min(5).max(200).nullable() }).partial(), raw)).filter(([k]) => k in raw));
  res.json(await C.updateDish(ctx(req), id, p));
});
ownerAppRouter.delete('/dishes/:id', requireOwnerRole, async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  res.json(await C.deleteDish(ctx(req), id));
});

/* ═══ TO'YXONA PROFILI VA RASMLAR ═══ */
ownerAppRouter.patch('/venue', requireOwnerRole, async (req, res) => {
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const p = parse(z.object({
    description: z.string().max(3000), address: z.string().max(300), phone: z.string().max(40),
    amenities: z.array(z.string().trim().min(1).max(40)).max(40), parking_spots: z.number().int().min(0).max(5000),
  }).partial(), raw);
  res.json(await C.patchVenue(ctx(req), Object.fromEntries(Object.entries(p).filter(([k]) => k in raw)) as C.ProfilePatch));
});

ownerAppRouter.post('/uploads/sign', requireOwnerRole, (req, res) => {
  const { purpose } = parse(z.object({ purpose: z.enum(['venue_photo', 'dish_photo', 'menu_photo']) }), req.body);
  res.json(C.signUpload(ctx(req), purpose));
});

ownerAppRouter.get('/venue/photos', async (req, res) => res.json(await C.listPhotos(ctx(req))));
ownerAppRouter.post('/venue/photos', requireOwnerRole, async (req, res) => {
  const { public_id } = parse(z.object({ public_id: z.string().min(5).max(200) }), req.body);
  res.status(201).json(await C.addPhoto(ctx(req), public_id));
});
ownerAppRouter.put('/venue/photos/order', requireOwnerRole, async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(objectId).max(100) }), req.body);
  res.json(await C.reorderPhotos(ctx(req), ids));
});
ownerAppRouter.delete('/venue/photos/:id', requireOwnerRole, async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  res.json(await C.removePhoto(ctx(req), id));
});

/* ═══ MOLIYA (faqat egasi) ═══ */
ownerAppRouter.get('/finance/overview', requireOwnerRole, async (req, res) => res.json(await F.overview(ctx(req))));
ownerAppRouter.get('/finance/operations', requireOwnerRole, async (req, res) => {
  const f = parse(z.object({ month: z.string().regex(ISO_MONTH).default(todayISO().slice(0, 7)), type: z.enum(['income', 'expense']).optional() }), req.query);
  res.json({ month: f.month, expense_categories: F.EXPENSE_LABELS, income_categories: F.INCOME_LABELS, items: await F.operations(ctx(req), f.month, f.type) });
});
ownerAppRouter.post('/transactions', requireOwnerRole, async (req, res) => {
  const b = parse(z.object({
    type: z.enum(['income', 'expense']), category: z.string().min(1).max(40), amount: z.number().int().positive('Summani kiriting'),
    date: z.string().regex(ISO_DATE).optional(), method: z.enum(PAY_METHODS).optional(), note: z.string().max(300).optional(), employee_id: objectId.optional(),
  }), req.body);
  res.status(201).json(await F.addTransaction(ctx(req), b));
});
ownerAppRouter.delete('/transactions/:id', requireOwnerRole, async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  res.json(await F.deleteTransaction(ctx(req), id));
});

/* ═══ ISHCHILAR ═══ */
const employeeIn = z.object({
  name: z.string().trim().min(2, 'Ismni kiriting').max(120), phone: z.string().max(40).optional(), position: z.string().max(80).optional(),
  pay_type: z.enum(['daily', 'monthly', 'per_event']).optional(), rate: z.number().int().min(0).optional(),
  hired_at: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).optional(), note: z.string().max(500).optional(), active: z.boolean().optional(),
  app_access: z.boolean().optional(), app_password: z.string().max(100).optional(),
});
ownerAppRouter.get('/employees', async (req, res) => {
  const c = ctx(req);
  const list = await F.listEmployees(c, c.role !== 'owner');
  // Xodim ish haqi, stavka va kirish ma'lumotlarini ko'rmaydi
  res.json(c.role === 'owner' ? list : list.map((e) => ({ id: e.id, name: e.name, phone: e.phone, position: e.position, active: e.active, events_count: e.events_count })));
});
ownerAppRouter.post('/employees', requireOwnerRole, async (req, res) => res.status(201).json(await F.createEmployee(ctx(req), parse(employeeIn, req.body) as F.EmployeeInput)));
ownerAppRouter.patch('/employees/:id', requireOwnerRole, async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const p = Object.fromEntries(Object.entries(parse(employeeIn.partial(), raw)).filter(([k]) => k in raw));
  res.json(await F.updateEmployee(ctx(req), id, p as Partial<F.EmployeeInput>));
});
ownerAppRouter.delete('/employees/:id', requireOwnerRole, async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  res.json(await F.removeEmployee(ctx(req), id));
});

void conflict;
