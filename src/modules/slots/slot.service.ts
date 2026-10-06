import { Types } from 'mongoose';
import { SlotModel } from './slot.model.js';
import { BookingModel } from '../bookings/booking.model.js';
import { SESSION_ORDER, monthDays, todayISO, type SessionCode } from '../../lib/dates.js';
import { conflict } from '../../lib/http-error.js';
import { logger } from '../../infrastructure/logger.js';

export type SlotStatus = 'free' | 'hold' | 'booked' | 'closed';
export type BusyMap = Map<string, Exclude<SlotStatus, 'free'>>;

const key = (hall: string, date: string, session: string) => `${hall}|${date}|${session}`;
const isDuplicate = (e: unknown) => (e as { code?: number })?.code === 11000;

/** Berilgan zallar va sana oralig'idagi band seanslar (muddati o'tgan hold hisobga olinmaydi) */
export async function loadBusy(hallIds: (string | Types.ObjectId)[], from: string, to: string, now = new Date()): Promise<BusyMap> {
  if (!hallIds.length) return new Map();
  const rows = await SlotModel.find(
    { hall_id: { $in: hallIds.map((h) => new Types.ObjectId(String(h))) }, date: { $gte: from, $lte: to } },
    { hall_id: 1, date: 1, session: 1, status: 1, hold_until: 1 },
  ).lean();
  const map: BusyMap = new Map();
  for (const r of rows) {
    if (r.status === 'hold' && (!r.hold_until || r.hold_until <= now)) continue;
    map.set(key(String(r.hall_id), r.date, r.session), r.status);
  }
  return map;
}

export function statusOf(busy: BusyMap, hallId: string, date: string, session: SessionCode, today: string): SlotStatus {
  if (date < today) return 'closed';
  return busy.get(key(hallId, date, session)) ?? 'free';
}

export async function hallCalendar(hallId: string, month: string) {
  const days = monthDays(month);
  const busy = await loadBusy([hallId], days[0], days[days.length - 1]);
  const today = todayISO();
  return days.map((date) => ({
    date,
    sessions: Object.fromEntries(SESSION_ORDER.map((s) => [s, statusOf(busy, hallId, date, s, today)])) as Record<SessionCode, SlotStatus>,
  }));
}

/**
 * Seansni atomik band qiladi. Unique indeks (hall_id, date, session) ikki parallel so'rovdan
 * faqat bittasini o'tkazadi. Muddati o'tgan hold bo'lsa — uni egallaydi.
 */
export async function reserveHold(p: {
  venueId: Types.ObjectId;
  hallId: Types.ObjectId;
  date: string;
  session: SessionCode;
  bookingId: Types.ObjectId;
  holdUntil: Date;
}) {
  const now = new Date();
  try {
    await SlotModel.create({
      venue_id: p.venueId, hall_id: p.hallId, date: p.date, session: p.session,
      status: 'hold', hold_until: p.holdUntil, booking_id: p.bookingId,
    });
    return;
  } catch (e) {
    if (!isDuplicate(e)) throw e;
  }
  const previous = await SlotModel.findOneAndUpdate(
    { hall_id: p.hallId, date: p.date, session: p.session, status: 'hold', hold_until: { $lte: now } },
    { $set: { hold_until: p.holdUntil, booking_id: p.bookingId } },
    { returnDocument: 'before' },
  ).lean();
  if (!previous) throw conflict('Bu seans allaqachon band qilingan. Boshqa seansni tanlang.', 'slot_taken');
  if (previous.booking_id) {
    await BookingModel.updateOne({ _id: previous.booking_id, status: 'pending' }, { $set: { status: 'cancelled', cancel_reason: 'expired' } });
  }
}

/** To'lov tasdiqlanganda: hold -> booked */
export async function markBooked(bookingId: Types.ObjectId) {
  await SlotModel.updateOne({ booking_id: bookingId }, { $set: { status: 'booked' }, $unset: { hold_until: 1 } });
}

export async function releaseByBooking(bookingId: Types.ObjectId) {
  await SlotModel.deleteOne({ booking_id: bookingId, status: { $in: ['hold', 'booked'] } });
}

/** Muddati o'tgan hold'larni tozalash (har daqiqada) */
export async function releaseExpiredHolds(now = new Date()) {
  const expired = await SlotModel.find({ status: 'hold', hold_until: { $lte: now } }, { _id: 1, booking_id: 1 }).lean();
  if (!expired.length) return 0;
  const bookingIds = expired.map((s) => s.booking_id).filter(Boolean);
  await BookingModel.updateMany({ _id: { $in: bookingIds }, status: 'pending' }, { $set: { status: 'cancelled', cancel_reason: 'expired' } });
  await SlotModel.deleteMany({ _id: { $in: expired.map((s) => s._id) }, status: 'hold', hold_until: { $lte: now } });
  logger.info('Muddati o‘tgan bronlar bekor qilindi', { count: expired.length });
  return expired.length;
}

/** Admin: seansni qo'lda yopish yoki ochish */
export async function setManualSlot(p: { venueId: Types.ObjectId; hallId: Types.ObjectId; date: string; session: SessionCode; status: 'closed' | 'booked' | 'free'; note?: string }) {
  const filter = { hall_id: p.hallId, date: p.date, session: p.session };
  const existing = await SlotModel.findOne(filter).lean();
  if (existing?.booking_id && (existing.status === 'booked' || (existing.status === 'hold' && existing.hold_until && existing.hold_until > new Date()))) {
    throw conflict('Bu seansda mijoz broni bor. Avval bronni bekor qiling.', 'has_booking');
  }
  if (p.status === 'free') {
    await SlotModel.deleteOne(filter);
    return;
  }
  await SlotModel.updateOne(
    filter,
    { $set: { venue_id: p.venueId, status: p.status, note: p.note }, $unset: { hold_until: 1, booking_id: 1 } },
    { upsert: true },
  );
}
