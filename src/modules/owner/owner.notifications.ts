import { Schema, model, Types } from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../infrastructure/logger.js';
import { normalizePhone } from '../../lib/phone.js';
import { sendSms } from '../owner-app/sms.service.js';
import { SESSION_LABELS, type SessionCodeAll } from '../../lib/sessions.js';
import { newBookingSms } from '../bookings/booking.flow.js';
import { VenueModel } from '../venues/venue.model.js';
import { VenueAccountModel } from './owner.models.js';
import { BookingModel } from '../bookings/booking.model.js';

/*
 * ═══ TO'YXONA EGASIGA BILDIRISHNOMALAR ═══
 * Mijoz bron qilganda (yoki muddat tugayotganda) egasi bilishi shart:
 *   1) panelda — saqlanadigan bildirishnoma (o'qilmagan soni tab belgisida, toast + ovoz);
 *   2) SMS — panel ochiq bo'lmasa ham (Eskiz; OWNER_BOOKING_SMS=false bilan o'chiriladi).
 * Panel ma'lumotni so'raydi (polling) — soket orqali shaxsiy ma'lumot ketmaydi.
 * Bildirishnoma xatosi bron yaratilishini HECH QACHON to'xtatmaydi.
 */
export const NOTIFY_KINDS = ['booking_new', 'booking_unanswered', 'booking_expired'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

const notificationSchema = new Schema(
  {
    venue_id: { type: Schema.Types.ObjectId, ref: 'Venue', required: true, index: true },
    kind: { type: String, enum: NOTIFY_KINDS, required: true },
    booking_id: { type: Schema.Types.ObjectId, ref: 'Booking', index: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    read_at: { type: Date },
    /** 90 kundan keyin avtomatik o'chadi */
    createdAt: { type: Date, default: () => new Date(), expires: 90 * 24 * 3600 },
  },
  { versionKey: false },
);
notificationSchema.index({ venue_id: 1, createdAt: -1 });
export const OwnerNotificationModel = model('OwnerNotification', notificationSchema);

export async function notifyOwner(venueId: Types.ObjectId | string, n: { kind: NotifyKind; booking_id?: Types.ObjectId | string; title: string; body?: string }) {
  try {
    await OwnerNotificationModel.create({ venue_id: venueId, ...n });
  } catch (e) {
    logger.error('Egasiga bildirishnoma yozilmadi', { error: String(e) });
  }
}

/** Egasining SMS telefoni: hisob telefoni, bo'lmasa to'yxona telefoni */
async function ownerPhone(venueId: Types.ObjectId | string): Promise<string | null> {
  const [acc, venue] = await Promise.all([
    VenueAccountModel.findOne({ venue_id: venueId }, { phone: 1 }).lean(),
    VenueModel.findById(venueId, { phone: 1 }).lean(),
  ]);
  return normalizePhone(acc?.phone) || normalizePhone(venue?.phone);
}

interface NewBookingLike {
  _id: Types.ObjectId; venue_id: Types.ObjectId; number: string; date: string; session: string;
  hall_name: string; guests: number; customer_name: string; customer_phone: string; total: number;
}

/** Yangi mijoz so'rovi: panel bildirishnomasi + SMS (ikkalasi ham xato bersa ham jim) */
export async function onBookingCreated(b: NewBookingLike) {
  const label = SESSION_LABELS[b.session as SessionCodeAll] ?? b.session;
  const d = b.date.split('-').reverse().join('.');
  await notifyOwner(b.venue_id, {
    kind: 'booking_new', booking_id: b._id,
    title: `Yangi bron so‘rovi · ${d}`,
    body: `${b.customer_name} · ${b.hall_name}, ${label}, ${b.guests} mehmon`,
  });
  if (env.OWNER_BOOKING_SMS !== 'true' || env.SMS_PROVIDER !== 'eskiz') return;
  try {
    const phone = await ownerPhone(b.venue_id);
    if (phone) await sendSms(phone, newBookingSms(b, label));
  } catch (e) {
    logger.error('Egasiga SMS yuborilmadi', { error: String(e) });
  }
}

/** Muddati tugagan so'rovlar haqida egasiga xabar (slot.service.releaseExpiredHolds chaqiradi) */
export async function notifyExpired(bookingIds: Types.ObjectId[]) {
  if (!bookingIds.length) return;
  try {
    const rows = await BookingModel.find({ _id: { $in: bookingIds } }, { venue_id: 1, customer_name: 1, date: 1, hall_name: 1, stage: 1 }).lean();
    for (const b of rows) {
      const d = b.date.split('-').reverse().join('.');
      await notifyOwner(b.venue_id, {
        kind: 'booking_expired', booking_id: b._id,
        title: b.stage === 'agreed' ? `Avans muddati o‘tdi · ${d}` : `So‘rov muddati tugadi · ${d}`,
        body: `${b.customer_name} · ${b.hall_name}. Seans bo‘shatildi.`,
      });
    }
  } catch (e) {
    logger.error('Muddati tugagan bronlar haqida xabar berilmadi', { error: String(e) });
  }
}

/** Egasi so'rovni 30 daqiqa ko'rmagan bo'lsa — bir marta eslatma (har daqiqada ishlaydi) */
export const UNANSWERED_AFTER_MIN = 30;
export async function remindUnanswered(at = new Date()) {
  const before = new Date(at.getTime() - UNANSWERED_AFTER_MIN * 60_000);
  const rows = await BookingModel.find(
    { status: 'pending', stage: { $ne: 'agreed' }, owner_seen_at: { $exists: false }, reminded_at: { $exists: false }, createdAt: { $lte: before }, hold_until: { $gt: at } },
    { venue_id: 1, customer_name: 1, date: 1, hall_name: 1, hold_until: 1 },
  ).limit(50).lean();
  for (const b of rows) {
    // Atomik belgi: ikki nusxadagi server ikki marta eslatmasin
    const marked = await BookingModel.updateOne({ _id: b._id, reminded_at: { $exists: false } }, { $set: { reminded_at: at } });
    if (!marked.modifiedCount) continue;
    const hrs = Math.max(1, Math.round((new Date(b.hold_until).getTime() - at.getTime()) / 3600_000));
    await notifyOwner(b.venue_id, {
      kind: 'booking_unanswered', booking_id: b._id,
      title: `Javob kutilmoqda · ${b.date.split('-').reverse().join('.')}`,
      body: `${b.customer_name} · ${b.hall_name}. ${UNANSWERED_AFTER_MIN} daqiqadan beri ko‘rilmadi, muddat ~${hrs} soat.`,
    });
  }
}
