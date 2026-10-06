import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { objectId, parse } from '../../lib/validate.js';
import { ISO_DATE } from '../../lib/dates.js';
import { unauthorized } from '../../lib/http-error.js';
import { optionalAuth, requireAuth } from '../auth/auth.middleware.js';
import { buildQuote } from './quote.service.js';
import { cancelBooking, createBooking, listMyBookings } from './booking.service.js';

const quoteSchema = z.object({
  venue_id: z.string().min(1).max(100),
  hall_id: objectId,
  date: z.string().regex(ISO_DATE, 'Format: YYYY-MM-DD'),
  session: z.enum(['morning', 'day', 'evening']),
  guests: z.coerce.number().int().min(1).max(5000),
  menu_package_id: objectId,
  vendor_ids: z.array(objectId).max(5).default([]),
});

const bookingSchema = quoteSchema.extend({
  event_type: z.enum(['nahorgi_osh', 'nikoh', 'kunduzgi', 'kechki']),
  customer_name: z.string().trim().min(2, 'Ismni kiriting').max(80),
  customer_phone: z
    .string()
    .transform((s) => s.replace(/[^\d+]/g, ''))
    .pipe(z.string().regex(/^\+998\d{9}$/, 'Telefon: +998XXXXXXXXX')),
});

export const quoteRouter = Router();
export const bookingRouter = Router();
export const meRouter = Router();

quoteRouter.post('/', async (req, res) => {
  const input = parse(quoteSchema, req.body);
  res.json((await buildQuote(input)).quote);
});

const bookingLimiter = rateLimit({ windowMs: 10 * 60_000, limit: env.BOOKING_RATE_LIMIT, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.', code: 'rate_limited' } });

bookingRouter.post('/', bookingLimiter, optionalAuth, async (req, res) => {
  if (!req.user && !env.ALLOW_ANONYMOUS_BOOKING) throw unauthorized('Bron qilish uchun Telegram orqali kiring');
  const input = parse(bookingSchema, req.body);
  res.status(201).json(await createBooking(input, req.user?.id));
});

bookingRouter.post('/:id/cancel', requireAuth, async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  res.json(await cancelBooking(id, { userId: req.user!.id }));
});

meRouter.get('/bookings', requireAuth, async (req, res) => {
  res.json(await listMyBookings(req.user!.id));
});
