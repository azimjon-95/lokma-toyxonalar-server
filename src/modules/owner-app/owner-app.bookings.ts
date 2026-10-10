import { Types } from 'mongoose';
import { addDaysISO, isWeekendISO, todayISO } from '../../lib/dates.js';
import { conflict, notFound, badRequest, forbidden } from '../../lib/http-error.js';
import { normalizePhone, phoneTail } from '../../lib/phone.js';
import { depositFor, pricePerGuest } from '../../lib/pricing.js';
import { EVENT_TYPES, SESSION_LABELS, type EventTypeAll, type SessionCodeAll } from '../../lib/sessions.js';
import { BookingModel } from '../bookings/booking.model.js';
import { cancelBooking, confirmBooking } from '../bookings/booking.service.js';
import { SlotModel } from '../slots/slot.model.js';
import { VenueModel } from '../venues/venue.model.js';
import { CancelledReservationModel, EmployeeModel, ReservationModel } from '../owner/owner.models.js';
import { claimSlot, releaseSlot } from '../owner/owner.slots.js';
import { ctx as _unused, type OwnerCtx } from './owner-app.auth.js';
import {
  appBookingDto, appBookingPayments, netPaid, reservationDto, reservationPayments, reservationStage,
  type AppBookingLike, type OwnerBookingDto, type OwnerStatus, type PaymentLike, type ReservationLike,
} from './owner-app.dto.js';
void _unused;

type AnyDoc = Record<string, unknown> & { _id: Types.ObjectId };
const oid = (s: string) => new Types.ObjectId(s);
const rx = (q: string) => new RegExp(q.trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
/** Qidiruv: matn bo'yicha yoki (kamida 3 raqam bo'lsa) telefon raqami bo'yicha — bo'shliq/tire e'tiborsiz */
const matcher = (q: string) => {
  const r = rx(q); const d = q.replace(/\D/g, '');
  return (text: string, phone = '') => r.test(text) || (d.length >= 3 && phone.replace(/\D/g, '').includes(d));
};

/* ═══ RO'YXAT ═══ */
export interface ListFilter { from?: string; to?: string; q?: string; status?: OwnerStatus; limit: number }

export async function listBookings(c: OwnerCtx, f: ListFilter): Promise<OwnerBookingDto[]> {
  const today = todayISO();
  const from = f.from ?? addDaysISO(today, -90);
  const to = f.to ?? addDaysISO(today, 400);
  const dateQ = { date: { $gte: from, $lte: to } };
  const [resv, apps, cancelled] = await Promise.all([
    ReservationModel.find({ venue_id: c.venueId, status: { $ne: 'closed' }, ...dateQ }).sort({ date: 1 }).limit(f.limit).lean(),
    BookingModel.find({ venue_id: c.venueId, ...dateQ }).sort({ date: 1 }).limit(f.limit).lean(),
    CancelledReservationModel.find({ venue_id: c.venueId, ...dateQ }).sort({ date: 1 }).limit(f.limit).lean(),
  ]);
  const now = new Date();
  let out: OwnerBookingDto[] = [
    ...resv.map((r) => reservationDto(c, r as unknown as ReservationLike)),
    ...cancelled.map((r) => reservationDto(c, r as unknown as ReservationLike, true)),
    ...(apps as unknown as AppBookingLike[])
      // Muddati o'tib bekor bo'lgan (mijoz to'lamagan) va hali ushlab turilayotgan, lekin vaqti o'tganlar ko'rsatilmaydi
      .filter((b) => b.cancel_reason !== 'expired' && !(b.status === 'pending' && b.hold_until <= now))
      .map((b) => appBookingDto(c, b)),
  ];
  if (f.status) out = out.filter((b) => b.status === f.status);
  if (f.q?.trim()) {
    const m = matcher(f.q);
    out = out.filter((b) => m(`${b.customer_name} ${b.number ?? ''} ${b.hall_name}`, b.customer_phone));
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time));
  return out.slice(0, f.limit);
}

/** Bron manbasi: Reservation | Booking | arxivdagi bekor qilingan Reservation */
type Found =
  | { kind: 'owner'; doc: AnyDoc & ReservationLike }
  | { kind: 'app'; doc: AnyDoc & AppBookingLike }
  | { kind: 'cancelled'; doc: AnyDoc & ReservationLike };

async function find(c: OwnerCtx, id: string): Promise<Found> {
  if (!Types.ObjectId.isValid(id)) throw notFound('Bron topilmadi');
  const filter = { _id: id, venue_id: c.venueId };
  const r = await ReservationModel.findOne({ ...filter, status: { $ne: 'closed' } }).lean();
  if (r) return { kind: 'owner', doc: r as never };
  const b = await BookingModel.findOne(filter).lean();
  if (b) return { kind: 'app', doc: b as never };
  const x = await CancelledReservationModel.findOne(filter).lean();
  if (x) return { kind: 'cancelled', doc: x as never };
  throw notFound('Bron topilmadi');
}

const dtoOf = (c: OwnerCtx, f: Found) =>
  f.kind === 'app' ? appBookingDto(c, f.doc) : reservationDto(c, f.doc, f.kind === 'cancelled');

export async function getBooking(c: OwnerCtx, id: string) {
  return dtoOf(c, await find(c, id));
}

/* ═══ NARX TAKLIFI (mijoz ilovasidagi bilan bir xil formula) ═══ */
export async function quoteFor(c: OwnerCtx, i: { hall_id: string; date: string; session: SessionCodeAll; guests: number; menu_id?: string }) {
  const venue = await VenueModel.findById(c.venueId, { sessions: 1, halls: 1, menu_packages: 1, weekend_factor: 1, deposit_percent: 1 }).lean();
  const hall = venue?.halls.find((h) => String(h._id) === i.hall_id);
  const session = venue?.sessions.find((s) => s.code === i.session);
  if (!venue || !hall) throw notFound('Zal topilmadi');
  if (!session) throw badRequest('Bu to‘yxonada bunday seans yo‘q');
  const menu = i.menu_id ? venue.menu_packages.find((m) => String(m._id) === i.menu_id) : undefined;
  const weekend = isWeekendISO(i.date);
  const mode = session.pricing_mode ?? 'per_guest';
  let ppg = 0; let total: number | null = null;
  if (mode === 'fixed') total = session.fixed_price ?? 0;
  else if (mode === 'per_guest' && menu) {
    ppg = pricePerGuest(menu, session, weekend, venue.weekend_factor);
    total = ppg * i.guests;
  }
  const warnings: string[] = [];
  if (i.guests > hall.capacity_max) warnings.push(`${hall.name} sig‘imi ${hall.capacity_max} kishi`);
  if (menu?.min_guests && i.guests < menu.min_guests) warnings.push(`${menu.name} kamida ${menu.min_guests} mehmon uchun`);
  return {
    pricing_mode: mode, price_per_guest: ppg, total, weekend, deposit_percent: venue.deposit_percent,
    deposit_suggested: total ? depositFor(total, venue.deposit_percent) : 0, capacity_max: hall.capacity_max,
    min_guests: session.min_guests, warnings,
  };
}

/* ═══ BANDLIK (forma uchun) ═══ */
export async function availability(c: OwnerCtx, date: string) {
  const slots = await SlotModel.find({ venue_id: c.venueId, date }).lean();
  const resIds = slots.map((s) => s.reservation_id).filter(Boolean);
  const bookIds = slots.map((s) => s.booking_id).filter(Boolean);
  const [resv, books] = await Promise.all([
    resIds.length ? ReservationModel.find({ _id: { $in: resIds } }, { customer_name: 1, description: 1 }).lean() : [],
    bookIds.length ? BookingModel.find({ _id: { $in: bookIds } }, { customer_name: 1 }).lean() : [],
  ]);
  const who = new Map<string, string>([
    ...resv.map((r) => [String(r._id), r.customer_name || (r.description ?? '').slice(0, 30)] as [string, string]),
    ...books.map((b) => [String(b._id), b.customer_name] as [string, string]),
  ]);
  const now = new Date();
  const today = todayISO();
  const codes = c.venue.sessions.map((s) => s.code);
  return {
    date,
    halls: c.venue.halls.map((h) => ({
      hall_id: String(h._id), name: h.name,
      sessions: codes.map((code) => {
        const s = slots.find((x) => String(x.hall_id) === String(h._id) && x.session === code);
        if (date < today) return { code, label: SESSION_LABELS[code as SessionCodeAll], state: 'past' as const, who: '' };
        if (!s || (s.status === 'hold' && (!s.hold_until || s.hold_until <= now))) return { code, label: SESSION_LABELS[code as SessionCodeAll], state: 'free' as const, who: '' };
        const name = s.reservation_id ? who.get(String(s.reservation_id)) : s.booking_id ? who.get(String(s.booking_id)) : s.note;
        return { code, label: SESSION_LABELS[code as SessionCodeAll], state: s.status === 'hold' ? ('hold' as const) : s.status === 'closed' ? ('closed' as const) : ('booked' as const), who: name ?? '' };
      }),
    })),
  };
}

/* ═══ YARATISH / TAHRIRLASH ═══ */
export interface BookingInput {
  hall_id: string;
  date: string;
  session: SessionCodeAll;
  event_type: EventTypeAll;
  customer_name: string;
  customer_phone: string;
  guests: number;
  menu_id?: string;
  pricing_mode?: 'per_guest' | 'fixed' | 'negotiable';
  price_per_guest?: number;
  total: number;
  address?: string;
  notes?: string;
  start_time?: string;
  end_time?: string;
  stage?: 'pending' | 'deposit' | 'confirmed';
}

async function validate(c: OwnerCtx, i: Partial<BookingInput>, ctxDoc?: { session?: string; event_type?: string }) {
  const hallId = i.hall_id;
  if (hallId && !c.venue.halls.some((h) => String(h._id) === hallId)) throw notFound('Zal topilmadi');
  const venue = await VenueModel.findById(c.venueId, { sessions: 1, menu_packages: 1 }).lean();
  const sessionCode = i.session ?? ctxDoc?.session;
  const session = venue?.sessions.find((s) => s.code === sessionCode);
  if (i.session && !session) throw badRequest('Bu to‘yxonada bunday seans yo‘q');
  const eventType = i.event_type ?? ctxDoc?.event_type;
  if (session && eventType && session.event_types?.length && !(session.event_types as string[]).includes(eventType)) {
    throw badRequest('Bu seansda tanlangan tadbir turini o‘tkazib bo‘lmaydi');
  }
  let menu: { id: string; name: string } | null = null;
  if (i.menu_id) {
    const m = venue?.menu_packages.find((x) => String(x._id) === i.menu_id);
    if (!m) throw notFound('Menyu paketi topilmadi');
    menu = { id: String(m._id), name: m.name };
  }
  const phone = i.customer_phone !== undefined ? normalizePhone(i.customer_phone) : undefined;
  if (i.customer_phone !== undefined && !phone) throw badRequest('Telefon raqamini to‘liq kiriting');
  return { menu, phone };
}

export async function createBooking(c: OwnerCtx, i: BookingInput): Promise<OwnerBookingDto> {
  if (i.date < todayISO()) throw badRequest('O‘tgan sanaga bron qilib bo‘lmaydi');
  if (i.total <= 0) throw badRequest('Jami summani kiriting');
  const { menu, phone } = await validate(c, i);
  const hall = c.venue.halls.find((h) => String(h._id) === i.hall_id)!;
  const stage = i.stage ?? 'pending';
  const _id = new Types.ObjectId();
  await claimSlot(c.venueId, hall._id, i.date, i.session, _id, i.customer_name, 'booked');
  try {
    const doc = await ReservationModel.create({
      _id, venue_id: c.venueId, hall_id: hall._id, hall_name: hall.name, date: i.date, session: i.session,
      status: stage === 'pending' ? 'tentative' : 'booked', stage, event_type: i.event_type,
      customer_name: i.customer_name, customer_phone: phone ?? '', guests: i.guests,
      pricing_mode: i.pricing_mode ?? 'per_guest', price_per_guest: i.price_per_guest ?? 0, total_price: i.total,
      menu_id: menu?.id ?? '', menu_name: menu?.name ?? '', address: i.address ?? '', description: i.notes ?? '',
      start_time: i.start_time ?? '', end_time: i.end_time ?? '', payments: [], staff_ids: [],
    });
    return reservationDto(c, doc.toObject() as unknown as ReservationLike);
  } catch (e) {
    await releaseSlot(hall._id, i.date, i.session, _id).catch(() => {});
    if ((e as { code?: number }).code === 11000) throw conflict('Bu seans allaqachon band', 'slot_taken');
    throw e;
  }
}

/** Tahrirlash — faqat egasi qo'lda kiritgan bron. Ilova broni uchun mijoz ma'lumoti o'zgarmaydi, faqat izoh/ishchilar */
export async function updateBooking(c: OwnerCtx, id: string, patch: Partial<BookingInput>): Promise<OwnerBookingDto> {
  const f = await find(c, id);
  if (f.kind === 'cancelled') throw conflict('Bekor qilingan bronni tahrirlab bo‘lmaydi', 'invalid_state');
  if (f.kind === 'app') {
    const allowed = Object.keys(patch).filter((k) => !['notes'].includes(k));
    if (allowed.length) throw conflict('Lokma ilovasi orqali kelgan bronning sana, mijoz va narxini o‘zgartirib bo‘lmaydi. Faqat izohni tahrirlash mumkin.', 'readonly_app_booking');
    await BookingModel.updateOne({ _id: f.doc._id }, { $set: { notes: patch.notes ?? '' } });
    return getBooking(c, id);
  }
  const old = f.doc;
  if (['completed'].includes(reservationStage(old))) throw conflict('Yakunlangan bronni tahrirlab bo‘lmaydi', 'invalid_state');
  const { menu, phone } = await validate(c, patch, { session: old.session, event_type: old.event_type ?? undefined });
  if (patch.date && patch.date < todayISO() && patch.date !== old.date) throw badRequest('O‘tgan sanaga ko‘chirib bo‘lmaydi');
  if (patch.total !== undefined && patch.total <= 0) throw badRequest('Jami summani kiriting');

  const set: Record<string, unknown> = {};
  const hallId = patch.hall_id ? oid(patch.hall_id) : (old.hall_id as Types.ObjectId);
  const date = patch.date ?? old.date;
  const session = (patch.session ?? old.session) as SessionCodeAll;
  const moved = String(hallId) !== String(old.hall_id) || date !== old.date || session !== old.session;
  if (patch.hall_id) set.hall_name = c.venue.halls.find((h) => String(h._id) === patch.hall_id)!.name;
  if (patch.hall_id) set.hall_id = hallId;
  if (patch.date) set.date = date;
  if (patch.session) set.session = session;
  if (patch.event_type) set.event_type = patch.event_type;
  if (patch.customer_name !== undefined) set.customer_name = patch.customer_name;
  if (phone) set.customer_phone = phone;
  if (patch.guests !== undefined) set.guests = patch.guests;
  if (patch.menu_id !== undefined) { set.menu_id = menu?.id ?? ''; set.menu_name = menu?.name ?? ''; }
  if (patch.pricing_mode) set.pricing_mode = patch.pricing_mode;
  if (patch.price_per_guest !== undefined) set.price_per_guest = patch.price_per_guest;
  if (patch.total !== undefined) set.total_price = patch.total;
  if (patch.address !== undefined) set.address = patch.address;
  if (patch.notes !== undefined) set.description = patch.notes;
  if (patch.start_time !== undefined) set.start_time = patch.start_time;
  if (patch.end_time !== undefined) set.end_time = patch.end_time;

  const rid = old._id;
  // Yangi seansni band qilamiz; band bo'lsa hech narsa o'zgarmaydi. Keyin eskisini bo'shatamiz.
  await claimSlot(c.venueId, hallId, date, session, rid, String(set.customer_name ?? old.customer_name ?? ''), 'booked');
  try {
    await ReservationModel.updateOne({ _id: rid }, { $set: set });
  } catch (e) {
    if (moved) await releaseSlot(hallId, date, session, rid).catch(() => {});
    if ((e as { code?: number }).code === 11000) throw conflict('Bu seans allaqachon band', 'slot_taken');
    throw e;
  }
  if (moved) await releaseSlot(old.hall_id as Types.ObjectId, old.date, old.session as SessionCodeAll, rid);
  return getBooking(c, id);
}

/* ═══ HOLAT ═══ */
export async function changeStatus(c: OwnerCtx, id: string, status: OwnerStatus): Promise<OwnerBookingDto> {
  const f = await find(c, id);
  if (f.kind === 'cancelled') throw conflict('Bekor qilingan bronning holatini o‘zgartirib bo‘lmaydi', 'invalid_state');

  if (f.kind === 'app') {
    const b = f.doc;
    if (status === 'cancelled') {
      if (b.status === 'cancelled') return appBookingDto(c, b);
      await cancelBooking(id, { admin: true }, 'owner');
    } else if (status === 'confirmed') {
      if (b.status === 'pending') await confirmBooking(id);
      else if (b.status === 'completed') await BookingModel.updateOne({ _id: b._id }, { $set: { status: 'confirmed' } });
      else if (b.status === 'cancelled') throw conflict('Bekor qilingan bronni tasdiqlab bo‘lmaydi', 'invalid_state');
    } else if (status === 'completed') {
      if (b.status === 'cancelled') throw conflict('Bekor qilingan bronni yakunlab bo‘lmaydi', 'invalid_state');
      if (b.status === 'pending') await confirmBooking(id);
      await BookingModel.updateOne({ _id: b._id }, { $set: { status: 'completed' } });
    } else {
      throw conflict('Lokma ilovasi orqali kelgan bron uchun bu holatni tanlab bo‘lmaydi', 'invalid_state');
    }
    return getBooking(c, id);
  }

  const r = f.doc;
  if (status === 'cancelled') {
    await cancelReservation(r);
    return reservationDto(c, r, true);
  }
  await ReservationModel.updateOne({ _id: r._id }, { $set: { stage: status, status: status === 'pending' ? 'tentative' : 'booked' } });
  return getBooking(c, id);
}

/** Egasi bronini bekor qilish: arxivga ko'chiradi va seansni bo'shatadi */
async function cancelReservation(r: AnyDoc & ReservationLike, reason = 'owner') {
  const full = await ReservationModel.findById(r._id).lean();
  if (!full) return;
  const { _id, ...rest } = full as unknown as Record<string, unknown> & { _id: Types.ObjectId };
  await CancelledReservationModel.create({ ...rest, _id, cancelled_at: new Date(), cancel_reason: reason });
  await ReservationModel.deleteOne({ _id });
  await releaseSlot(r.hall_id as Types.ObjectId, r.date, r.session as SessionCodeAll, _id);
}

/* ═══ TO'LOVLAR ═══ */
export interface PaymentInput { kind: 'deposit' | 'payment' | 'refund'; amount: number; method: 'cash' | 'card' | 'transfer' | 'click' | 'payme' | 'other'; date?: string; note?: string }

export async function addPayment(c: OwnerCtx, id: string, p: PaymentInput): Promise<OwnerBookingDto> {
  const f = await find(c, id);
  if (f.kind === 'cancelled' || (f.kind === 'app' && f.doc.status === 'cancelled')) throw conflict('Bekor qilingan bronga to‘lov yozib bo‘lmaydi', 'invalid_state');
  const payments: PaymentLike[] = f.kind === 'app' ? appBookingPayments(f.doc) : reservationPayments(f.doc);
  const total = f.kind === 'app' ? f.doc.total : f.doc.total_price ?? 0;
  const status = f.kind === 'app' ? f.doc.status : reservationStage(f.doc);
  if (status === 'completed') throw conflict('Yakunlangan bronga to‘lov yozib bo‘lmaydi', 'invalid_state');
  const paid = netPaid(payments);
  if (p.kind === 'refund') {
    if (p.amount > paid) throw badRequest(`Qaytariladigan summa to‘langandan oshmasin: ${paid}`, { max: paid });
  } else if (p.amount > Math.max(0, total - paid)) {
    throw badRequest(`Qoldiqdan oshmasin: ${Math.max(0, total - paid)}`, { max: Math.max(0, total - paid) });
  }
  const entry = { _id: new Types.ObjectId(), amount: p.amount, kind: p.kind, method: p.method, date: p.date ?? todayISO(), note: p.note ?? '', at: new Date() };
  if (f.kind === 'app') {
    // Birinchi qo'lda yozuvdan oldin ilova avansi (agar bo'lsa) ham aniq yozuvga aylanadi — hisob o'zgarmaydi
    const existing = f.doc.payments?.length ? [] : payments.map((x) => ({ ...x, _id: new Types.ObjectId() }));
    await BookingModel.updateOne({ _id: f.doc._id }, { $push: { payments: { $each: [...existing, entry] } } });
    if (f.doc.status === 'pending' && p.kind !== 'refund') await confirmBooking(id);
  } else {
    const set: Record<string, unknown> = {};
    if (p.kind !== 'refund' && (status === 'pending' || status === 'deposit')) { set.stage = 'confirmed'; set.status = 'booked'; }
    await ReservationModel.updateOne({ _id: f.doc._id }, { $push: { payments: entry }, ...(Object.keys(set).length ? { $set: set } : {}) });
  }
  return getBooking(c, id);
}

/* ═══ ISHCHILAR BIRIKTIRISH ═══ */
export async function assignStaff(c: OwnerCtx, id: string, employeeIds: string[]): Promise<OwnerBookingDto> {
  const f = await find(c, id);
  if (f.kind === 'cancelled') throw conflict('Bekor qilingan bronga ishchi biriktirib bo‘lmaydi', 'invalid_state');
  const unique = [...new Set(employeeIds)];
  if (unique.length) {
    const n = await EmployeeModel.countDocuments({ _id: { $in: unique }, venue_id: c.venueId, active: true });
    if (n !== unique.length) throw notFound('Ishchi topilmadi');
  }
  const Model = f.kind === 'app' ? BookingModel : ReservationModel;
  await (Model as typeof ReservationModel).updateOne({ _id: f.doc._id }, { $set: { staff_ids: unique.map(oid) } });
  return getBooking(c, id);
}

/* ═══ MIJOZLAR ═══ */
export async function listClients(c: OwnerCtx, q?: string) {
  const all = await listBookings(c, { from: '2000-01-01', to: '2100-01-01', limit: 5000 });
  const today = todayISO();
  const upcoming = all.filter((b) => b.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past = all.filter((b) => b.date < today).sort((a, b) => b.date.localeCompare(a.date));
  const map = new Map<string, { key: string; name: string; phone: string; bookings_count: number; last_booking: OwnerBookingDto }>();
  // Har mijoz uchun eng dolzarb (yaqin kelajak yoki eng so'nggi) bron
  for (const b of [...upcoming, ...past]) {
    const key = phoneTail(b.customer_phone) || b.customer_name;
    const e = map.get(key);
    if (e) e.bookings_count += 1;
    else map.set(key, { key, name: b.customer_name, phone: b.customer_phone, bookings_count: 1, last_booking: b });
  }
  let list = [...map.values()];
  if (q?.trim()) { const m = matcher(q); list = list.filter((x) => m(x.name, x.phone)); }
  return list;
}

export function assertCanWrite(c: OwnerCtx) {
  if (!c.venue || c.venue.status === 'blocked') throw forbidden('To‘yxona bloklangan');
}

export const EVENT_CODES = EVENT_TYPES;
