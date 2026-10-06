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

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const eventType = z.enum(['nahorgi_osh', 'nikoh', 'kunduzgi', 'kechki']);
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
    code: z.enum(['morning', 'day', 'evening']),
    start_time: z.string().regex(/^\d{2}:\d{2}$/),
    end_time: z.string().regex(/^\d{2}:\d{2}$/),
    event_types: z.array(eventType).min(1),
    price_factor: z.number().positive(),
    min_guests: z.number().int().positive(),
  })).min(1),
  menu_packages: z.array(z.object({ name: z.string(), items_text: z.string().default(''), price_per_guest: z.number().int().nonnegative() })).min(1),
  weekend_factor: z.number().min(1).max(3).default(1.15),
  deposit_percent: z.number().min(0).max(100).default(30),
  guests_min: z.number().int().positive().default(150),
  status: z.enum(['active', 'hidden']).default('active'),
});

adminRouter.get('/venues', async (_req, res) => {
  res.json(await VenueModel.find().sort({ name: 1 }).lean());
});
adminRouter.post('/venues', async (req, res) => {
  res.status(201).json(await VenueModel.create(parse(venueSchema, req.body)));
});
adminRouter.patch('/venues/:id', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const body = parse(venueSchema.partial(), req.body);
  const v = await VenueModel.findByIdAndUpdate(id, { $set: body }, { returnDocument: 'after', runValidators: true }).lean();
  if (!v) throw notFound('To‘yxona topilmadi');
  res.json(v);
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
});
adminRouter.get('/vendors', async (_req, res) => {
  res.json(await VendorModel.find().sort({ type: 1, price: 1 }).lean());
});
adminRouter.post('/vendors', async (req, res) => {
  res.status(201).json(await VendorModel.create(parse(vendorSchema, req.body)));
});
adminRouter.patch('/vendors/:id', async (req, res) => {
  const { id } = parse(z.object({ id: objectId }), req.params);
  const v = await VendorModel.findByIdAndUpdate(id, { $set: parse(vendorSchema.partial(), req.body) }, { returnDocument: 'after', runValidators: true }).lean();
  if (!v) throw notFound('Xizmat topilmadi');
  res.json(v);
});

/** Seansni qo'lda yopish (ta'mir, oflayn mijoz) yoki ochish */
adminRouter.put('/slots', async (req, res) => {
  const b = parse(
    z.object({
      hall_id: objectId,
      date: z.string().regex(ISO_DATE),
      session: z.enum(['morning', 'day', 'evening']),
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
