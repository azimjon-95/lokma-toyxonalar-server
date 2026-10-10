import { Types } from 'mongoose';
import { conflict } from '../../lib/http-error.js';
import { SlotModel } from '../slots/slot.model.js';
import type { SessionCodeAll } from '../../lib/sessions.js';

/*
 * Egasi bronlari (Reservation) seansni band qilishi/bo'shatishi — LokmaGo admin paneli
 * (owner.routes.ts) va mobil ilova (owner-app) uchun UMUMIY mantiq.
 */
/** Seans tanlangan zal/sana uchun bo'shmi — ilova broni yoki boshqa yozuv bo'lsa 409 */
export async function claimSlot(venueId: Types.ObjectId, hallId: Types.ObjectId, date: string, session: SessionCodeAll, reservationId: Types.ObjectId, note: string, status: 'booked' | 'closed') {
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
export async function releaseSlot(hallId: Types.ObjectId, date: string, session: SessionCodeAll, reservationId: Types.ObjectId) {
  await SlotModel.deleteOne({ hall_id: hallId, date, session, reservation_id: reservationId });
}

