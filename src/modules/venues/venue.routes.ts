import { SESSION_CODES, EVENT_TYPES, PRICING_MODES } from '../../lib/sessions.js';
import { Router } from 'express';
import { z } from 'zod';
import { lat, lng, objectId, parse } from '../../lib/validate.js';
import { ISO_MONTH } from '../../lib/dates.js';
import { notFound } from '../../lib/http-error.js';
import { freeSoon, listVenues, venueDetail } from './venue.service.js';
import { VenueModel } from './venue.model.js';
import { hallCalendar } from '../slots/slot.service.js';

export const venueRouter = Router();
export const hallRouter = Router();

// 1000 km — "Butun O'zbekiston" tanlovi (wedding ilovasi, src/lib/regions.ts)
const radius = z.coerce.number().min(1).max(1000).default(20);
const eventType = z.enum(EVENT_TYPES);

venueRouter.get('/', async (req, res) => {
  const q = parse(
    z.object({
      lat, lng, radius_km: radius,
      q: z.string().trim().max(80).optional(),
      filter: z.enum(['all', 'free_today', 'cheap', 'big', 'parking']).default('all'),
      event_type: eventType.optional(),
      sort: z.enum(['distance', 'price_asc', 'price_desc', 'rating']).default('distance'),
    }),
    req.query,
  );
  res.json(await listVenues(q));
});

venueRouter.get('/free-soon', async (req, res) => {
  const q = parse(z.object({ lat, lng, radius_km: radius, days: z.coerce.number().int().min(1).max(14).default(3) }), req.query);
  res.json(await freeSoon(q));
});

venueRouter.get('/:slug', async (req, res) => {
  const { slug } = parse(z.object({ slug: z.string().min(1).max(100) }), req.params);
  const from = parse(z.object({ lat: lat.optional(), lng: lng.optional() }), req.query);
  const v = await venueDetail(slug, { lat: from.lat ?? 41.3111, lng: from.lng ?? 69.2797 });
  res.json(v);
});

hallRouter.get('/:hallId/calendar', async (req, res) => {
  const { hallId } = parse(z.object({ hallId: objectId }), req.params);
  const { month } = parse(z.object({ month: z.string().regex(ISO_MONTH, 'Format: YYYY-MM') }), req.query);
  const exists = await VenueModel.exists({ 'halls._id': hallId, status: 'active' });
  if (!exists) throw notFound('Zal topilmadi');
  res.json(await hallCalendar(hallId, month));
});
