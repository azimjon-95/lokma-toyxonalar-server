import type { EventTypeAll } from '../../lib/sessions.js';
import { Types } from 'mongoose';
import { VenueModel, type Venue } from './venue.model.js';
import { VendorModel } from '../vendors/vendor.model.js';
import { loadBusy, statusOf, type BusyMap } from '../slots/slot.service.js';
import { addDaysISO, todayISO, SESSION_PREFERENCE, type SessionCode } from '../../lib/dates.js';
import { resizeUrl } from '../cloudinary/cloudinary.service.js';
import { boundingBox, distanceKm, type LatLng } from '../../lib/geo.js';
import { priceRange } from '../../lib/pricing.js';
import { notFound } from '../../lib/http-error.js';

const NEXT_FREE_DAYS = 30;
type LeanVenue = Venue & { _id: Types.ObjectId };

export type QuickFilter = 'all' | 'free_today' | 'cheap' | 'big' | 'parking';
export type SortKey = 'distance' | 'price_asc' | 'price_desc' | 'rating';
export type EventType = EventTypeAll;

export interface VenueQuery extends LatLng {
  radius_km: number;
  q?: string;
  filter?: QuickFilter;
  event_type?: EventType;
  sort?: SortKey;
}

const hallIds = (v: LeanVenue) => v.halls.map((h) => String(h._id));

function sessionsFor(v: LeanVenue, eventType?: EventType): SessionCode[] {
  return SESSION_PREFERENCE.filter((code) => {
    const s = v.sessions.find((x) => x.code === code);
    // Narxi kelishiladigan seans "keyingi bo'sh kun" qidiruviga kirmaydi (onlayn bron yo'q)
    return s && s.pricing_mode !== 'negotiable' && (!eventType || s.event_types.includes(eventType));
  });
}

function firstFree(v: LeanVenue, busy: BusyMap, from: string, days: number, sessions: SessionCode[]) {
  const today = todayISO();
  for (let i = 0; i < days; i++) {
    const date = addDaysISO(from, i);
    for (const s of sessions) {
      if (hallIds(v).some((h) => statusOf(busy, h, date, s, today) === 'free')) return { date, session: s };
    }
  }
  return null;
}

function toListItem(v: LeanVenue, from: LatLng, nextFree: { date: string; session: SessionCode } | null) {
  const range = priceRange(v.menu_packages, v.sessions, v.weekend_factor);
  return {
    id: String(v._id),
    slug: v.slug,
    name: v.name,
    district: v.district,
    lat: v.lat,
    lng: v.lng,
    rating: v.rating,
    reviews_count: v.reviews_count,
    photos: v.photos.slice(0, 3).map((u) => resizeUrl(u, 'card')),
    photos_count: v.photos.length,
    capacity_min: Math.min(...v.halls.map((h) => h.capacity_min)),
    capacity_max: Math.max(...v.halls.map((h) => h.capacity_max)),
    price_from: range.from,
    price_to: range.to,
    has_parking: v.parking_spots > 0,
    next_free: nextFree,
    distance_km: Math.round(distanceKm(from, v) * 10) / 10,
  };
}
export type VenueListItem = ReturnType<typeof toListItem>;

async function venuesWithin(q: LatLng & { radius_km: number }) {
  const box = boundingBox(q, q.radius_km);
  const rows = (await VenueModel.find({
    status: 'active',
    lat: { $gte: box.minLat, $lte: box.maxLat },
    lng: { $gte: box.minLng, $lte: box.maxLng },
  }).lean()) as LeanVenue[];
  return rows.filter((v) => distanceKm(q, v) <= q.radius_km);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function listVenues(q: VenueQuery): Promise<VenueListItem[]> {
  let venues = await venuesWithin(q);
  if (q.q?.trim()) {
    const re = new RegExp(escapeRegex(q.q.trim()), 'i');
    venues = venues.filter((v) => re.test(v.name) || re.test(v.district));
  }
  const today = todayISO();
  const busy = await loadBusy(venues.flatMap(hallIds), today, addDaysISO(today, NEXT_FREE_DAYS));

  let items = venues
    .map((v) => {
      const sessions = sessionsFor(v, q.event_type);
      return { v, item: toListItem(v, q, sessions.length ? firstFree(v, busy, today, NEXT_FREE_DAYS, sessions) : null) };
    })
    .filter(({ item }) => !q.event_type || item.next_free !== null)
    .map(({ item }) => item);

  switch (q.filter) {
    case 'free_today': items = items.filter((v) => v.next_free?.date === today); break;
    case 'cheap': items = items.filter((v) => v.price_from <= 150_000); break;
    case 'big': items = items.filter((v) => v.capacity_max >= 500); break;
    case 'parking': items = items.filter((v) => v.has_parking); break;
  }

  const sorters: Record<SortKey, (a: VenueListItem, b: VenueListItem) => number> = {
    distance: (a, b) => a.distance_km - b.distance_km,
    price_asc: (a, b) => a.price_from - b.price_from || a.distance_km - b.distance_km,
    price_desc: (a, b) => b.price_from - a.price_from || a.distance_km - b.distance_km,
    rating: (a, b) => b.rating - a.rating || a.distance_km - b.distance_km,
  };
  return items.sort(sorters[q.sort ?? 'distance']);
}

export async function freeSoon(q: LatLng & { radius_km: number; days: number; limit?: number }) {
  const venues = await venuesWithin(q);
  const today = todayISO();
  const busy = await loadBusy(venues.flatMap(hallIds), today, addDaysISO(today, q.days));
  const out: { venue: VenueListItem; date: string; session: SessionCode }[] = [];
  for (const v of venues) {
    const slot = firstFree(v, busy, today, q.days, sessionsFor(v));
    if (!slot) continue;
    const next = firstFree(v, busy, today, NEXT_FREE_DAYS, sessionsFor(v));
    out.push({ venue: toListItem(v, q, next), ...slot });
  }
  return out
    .sort((a, b) => a.date.localeCompare(b.date) || a.venue.distance_km - b.venue.distance_km)
    .slice(0, q.limit ?? 6);
}

export async function findVenue(idOrSlug: string): Promise<LeanVenue> {
  const filter = Types.ObjectId.isValid(idOrSlug) && idOrSlug.length === 24 ? { _id: idOrSlug } : { slug: idOrSlug.toLowerCase() };
  const v = (await VenueModel.findOne({ ...filter, status: 'active' }).lean()) as LeanVenue | null;
  if (!v) throw notFound('To‘yxona topilmadi');
  return v;
}

export async function vendorsFor(venueId: Types.ObjectId) {
  // Xizmatlar soni kichik — barcha bazalarda bir xil ishlashi uchun filtr kodda
  const all = await VendorModel.find({ active: true }).sort({ type: 1, price: 1 }).lean();
  const rows = all.filter((x) => !x.venue_ids?.length || x.venue_ids.some((id) => String(id) === String(venueId)));
  return rows.map((x) => ({
    id: String(x._id),
    type: x.type,
    name: x.name,
    description: x.description,
    price: x.price,
    ...(x.photo ? { photo: x.photo } : {}),
    ...(x.rating != null ? { rating: x.rating } : {}),
  }));
}

export async function venueDetail(slug: string, from: LatLng) {
  const v = await findVenue(slug);
  const today = todayISO();
  const busy = await loadBusy(hallIds(v), today, addDaysISO(today, NEXT_FREE_DAYS));
  const base = toListItem(v, from, firstFree(v, busy, today, NEXT_FREE_DAYS, sessionsFor(v)));
  return {
    ...base,
    photos: v.photos,
    address: v.address,
    phone: v.phone,
    description: v.description,
    parking_spots: v.parking_spots,
    amenities: v.amenities,
    halls: v.halls.map((h) => ({ id: String(h._id), name: h.name, capacity_min: h.capacity_min, capacity_max: h.capacity_max })),
    sessions: v.sessions.map((s) => ({
      code: s.code, start_time: s.start_time, end_time: s.end_time,
      event_types: s.event_types, price_factor: s.price_factor, min_guests: s.min_guests,
    })),
    menu_packages: v.menu_packages.map((m) => ({ id: String(m._id), name: m.name, items_text: m.items_text, price_per_guest: m.price_per_guest, min_guests: m.min_guests ?? 0 })),
    vendors: await vendorsFor(v._id),
    weekend_factor: v.weekend_factor,
    deposit_percent: v.deposit_percent,
    guests_min: v.guests_min,
    guests_max: base.capacity_max,
  };
}
