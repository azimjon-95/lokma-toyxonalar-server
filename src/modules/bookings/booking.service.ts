import type { EventTypeAll } from '../../lib/sessions.js';
import { randomInt } from 'node:crypto';
import { Types } from 'mongoose';
import { BookingModel } from './booking.model.js';
import { buildQuote, type QuoteInput } from './quote.service.js';
import { markBooked, releaseByBooking, reserveHold } from '../slots/slot.service.js';
import { env } from '../../config/env.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/http-error.js';
import { logger } from '../../infrastructure/logger.js';

export interface BookingInput extends QuoteInput {
  event_type: EventTypeAll;
  customer_name: string;
  customer_phone: string;
}

interface BookingDoc {
  _id: Types.ObjectId;
  number: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed';
  cancel_reason?: string | null;
  user_id?: Types.ObjectId | null;
  customer_name: string;
  customer_phone: string;
  venue_id: Types.ObjectId;
  venue_name: string;
  hall_name: string;
  date: string;
  session: string;
  event_type: string;
  guests: number;
  menu?: { name?: string | null } | null;
  extras: { vendor_id?: string | null; name?: string | null; type?: string | null; price?: number | null }[];
  price_per_guest: number;
  total: number;
  deposit: number;
  payment_url?: string | null;
  hold_until: Date;
  createdAt?: Date;
}
const asDoc = (x: unknown) => x as BookingDoc;

const newNumber = () => `TY-${Date.now().toString(36).toUpperCase().slice(-5)}${randomInt(10, 99)}`;

export function toPublic(b: BookingDoc) {
  return {
    id: String(b._id),
    number: b.number,
    status: b.status,
    venue_id: String(b.venue_id),
    venue_name: b.venue_name,
    hall_name: b.hall_name,
    date: b.date,
    session: b.session,
    event_type: b.event_type,
    guests: b.guests,
    menu_name: b.menu?.name ?? '',
    extras: b.extras,
    price_per_guest: b.price_per_guest,
    total: b.total,
    deposit: b.deposit,
    payment_url: b.payment_url ?? null,
    hold_until: b.hold_until.toISOString(),
    created_at: (b.createdAt ?? new Date()).toISOString(),
    ...(b.cancel_reason ? { cancel_reason: b.cancel_reason } : {}),
  };
}

export async function createBooking(input: BookingInput, userId?: string) {
  const { quote, venue, hall, session, menu } = await buildQuote(input);
  if (!session.event_types.includes(input.event_type)) {
    throw badRequest('Bu seansda tanlangan tadbir turini o‘tkazib bo‘lmaydi');
  }

  const _id = new Types.ObjectId();
  const holdUntil = new Date(Date.now() + env.HOLD_MINUTES * 60_000);

  // 1) Avval seansni band qilamiz (unique indeks poygani hal qiladi)
  await reserveHold({ venueId: venue._id, hallId: hall._id, date: input.date, session: input.session, bookingId: _id, holdUntil });

  // 2) Keyin bronni yozamiz; xato bo'lsa seansni bo'shatamiz
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const doc = await BookingModel.create({
          _id,
          number: newNumber(),
          status: 'pending',
          user_id: userId ? new Types.ObjectId(userId) : undefined,
          customer_name: input.customer_name,
          customer_phone: input.customer_phone,
          venue_id: venue._id,
          venue_name: venue.name,
          hall_id: hall._id,
          hall_name: hall.name,
          date: input.date,
          session: input.session,
          event_type: input.event_type,
          guests: input.guests,
          menu: { id: String(menu._id), name: menu.name, price_per_guest: menu.price_per_guest },
          extras: quote.extras,
          price_per_guest: quote.price_per_guest,
          venue_total: quote.venue_total,
          total: quote.total,
          deposit: quote.deposit,
          payment_url: null, // To'lov provayderi ulanganda shu yerda yaratiladi (Click/Payme/Uzum)
          hold_until: holdUntil,
        });
        logger.info('Yangi bron', { number: doc.number, venue: venue.slug, date: input.date, session: input.session });
        return toPublic(asDoc(doc.toObject()));
      } catch (e) {
        if ((e as { code?: number }).code === 11000 && attempt < 3) continue; // raqam to'qnashuvi
        throw e;
      }
    }
  } catch (e) {
    await releaseByBooking(_id).catch(() => {});
    throw e;
  }
}

export async function listMyBookings(userId: string) {
  const rows = await BookingModel.find({ user_id: userId }).sort({ createdAt: -1 }).limit(100).lean();
  return rows.map((r) => toPublic(asDoc(r)));
}

async function load(id: string) {
  if (!Types.ObjectId.isValid(id)) throw notFound('Bron topilmadi');
  const b = await BookingModel.findById(id).lean();
  if (!b) throw notFound('Bron topilmadi');
  return asDoc(b);
}

export async function cancelBooking(id: string, by: { userId?: string; admin?: boolean }, reason = 'customer') {
  const b = await load(id);
  if (!by.admin && String(b.user_id) !== by.userId) throw forbidden();
  if (b.status === 'cancelled' || b.status === 'completed') throw conflict('Bu bronni bekor qilib bo‘lmaydi', 'invalid_state');
  await BookingModel.updateOne({ _id: b._id }, { $set: { status: 'cancelled', cancel_reason: reason } });
  await releaseByBooking(b._id);
  return toPublic({ ...b, status: 'cancelled', cancel_reason: reason });
}

/** Avans to'langanda (admin yoki to'lov webhook'i) */
export async function confirmBooking(id: string) {
  const b = await load(id);
  if (b.status !== 'pending') throw conflict('Faqat kutilayotgan bronni tasdiqlash mumkin', 'invalid_state');
  const res = await BookingModel.updateOne({ _id: b._id, status: 'pending' }, { $set: { status: 'confirmed', paid_at: new Date() } });
  if (!res.modifiedCount) throw conflict('Bron holati o‘zgargan, qayta urinib ko‘ring', 'invalid_state');
  await markBooked(b._id);
  return toPublic({ ...b, status: 'confirmed' });
}

export async function adminListBookings(f: { status?: string; date?: string; from?: string; to?: string; venue_id?: string; q?: string; limit: number }) {
  const q: Record<string, unknown> = {};
  if (f.status) q.status = f.status;
  if (f.date) q.date = f.date;
  else if (f.from || f.to) q.date = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) };
  if (f.q?.trim()) {
    const term = f.q.trim().slice(0, 60);
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [{ number: rx }, { customer_name: rx }, { customer_phone: rx }, { venue_name: rx }];
  }
  if (f.venue_id && Types.ObjectId.isValid(f.venue_id)) q.venue_id = f.venue_id;
  const rows = (await BookingModel.find(q).sort({ createdAt: -1 }).limit(f.limit).lean()).map(asDoc);
  return rows.map((b) => ({ ...toPublic(b), customer_name: b.customer_name, customer_phone: b.customer_phone }));
}


/*
 * ═══ LOKMA FOYDALANUVCHISINING BRONLARI (telefon bo'yicha) ═══
 * Mijoz alohida ro'yxatdan o'tmaydi — Lokma Go orqali keladi. Bron telefon
 * raqami bilan saqlangani uchun, Lokma serveri (ishonchli, X-Admin-Key bilan)
 * tizimga kirgan foydalanuvchining O'Z telefonini yuboradi va shu raqamdagi
 * bronlarni oladi. Eski va yangi yozuvlar turli formatda (+998 90 123 45 67 /
 * +998901234567) bo'lgani uchun oxirgi 9 raqam bo'yicha moslanadi.
 */
export const phoneTail = (v: string) => String(v || '').replace(/\D/g, '').slice(-9);

function phoneRegex(tail: string) {
  // 9 ta raqam orasida ixtiyoriy belgilar (bo'sh joy, tire) bo'lishi mumkin, qator oxirigacha
  return new RegExp(`${tail.split('').join('\\D*')}\\D*$`);
}

export async function listBookingsByPhone(phone: string) {
  const tail = phoneTail(phone);
  if (tail.length !== 9) return [];
  const rows = (await BookingModel.find({ customer_phone: phoneRegex(tail) }).sort({ createdAt: -1 }).limit(100).lean()).map(asDoc);
  return rows
    .filter((b) => phoneTail(b.customer_phone) === tail) // regex tasodifiy mos kelishidan himoya
    .map((b) => toPublic(b));
}

/** Foydalanuvchi o'z bronini bekor qiladi: bron telefoni uning telefoniga mos bo'lishi shart */
export async function cancelBookingByPhone(id: string, phone: string) {
  const b = await load(id);
  const tail = phoneTail(phone);
  if (tail.length !== 9 || phoneTail(b.customer_phone) !== tail) throw forbidden();
  return cancelBooking(id, { admin: true }, 'customer');
}
