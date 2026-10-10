import type { Types } from 'mongoose';
import { SESSION_LABELS, type EventTypeAll } from '../../lib/sessions.js';
import { normalizePhone } from '../../lib/phone.js';
import type { OwnerCtx, AppRole } from './owner-app.auth.js';

/*
 * ═══ BRON: YAGONA KO'RINISH ═══
 * Egasi qo'lda kiritgan bron (Reservation) va Lokma ilovasi orqali kelgan bron (Booking)
 * mobil ilovaga BIR XIL shaklda beriladi. Farqi faqat `source`: 'owner' | 'app'.
 */
export type OwnerStatus = 'pending' | 'deposit' | 'confirmed' | 'completed' | 'cancelled';
export const OWNER_STATUSES: OwnerStatus[] = ['pending', 'deposit', 'confirmed', 'completed', 'cancelled'];
export type PayKind = 'deposit' | 'payment' | 'refund';

export const EVENT_LABELS: Record<EventTypeAll, string> = {
  nahorgi_osh: 'Nahorgi osh',
  nikoh: 'Nikoh to‘yi',
  kunduzgi: 'Kunduzgi to‘y',
  kechki: 'Kechki to‘y',
  tadbir: 'Maxsus tadbir',
};

export interface PaymentLike {
  _id: Types.ObjectId | string;
  amount: number;
  method?: string | null;
  kind?: string | null;
  date: string;
  note?: string | null;
  at?: Date | null;
}

export interface ReservationLike {
  _id: Types.ObjectId;
  hall_id: Types.ObjectId;
  hall_name?: string | null;
  date: string;
  session: string;
  status: 'booked' | 'tentative' | 'closed';
  stage?: string | null;
  event_type?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  guests?: number | null;
  pricing_mode?: string | null;
  price_per_guest?: number | null;
  total_price?: number | null;
  payments?: PaymentLike[] | null;
  description?: string | null;
  menu_id?: string | null;
  menu_name?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  address?: string | null;
  staff_ids?: Types.ObjectId[] | null;
  createdAt?: Date;
  cancelled_at?: Date | null;
  cancel_reason?: string | null;
}

export interface AppBookingLike {
  _id: Types.ObjectId;
  number: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed';
  cancel_reason?: string | null;
  customer_name: string;
  customer_phone: string;
  hall_id: Types.ObjectId;
  hall_name: string;
  date: string;
  session: string;
  event_type: string;
  guests: number;
  menu?: { id?: string | null; name?: string | null; price_per_guest?: number | null } | null;
  extras?: { vendor_id?: string | null; name?: string | null; type?: string | null; price?: number | null }[] | null;
  price_per_guest: number;
  venue_total: number;
  total: number;
  deposit: number;
  paid_at?: Date | null;
  hold_until: Date;
  payments?: PaymentLike[] | null;
  staff_ids?: Types.ObjectId[] | null;
  notes?: string | null;
  createdAt?: Date;
}

const tashkentDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export const netPaid = (ps: PaymentLike[]) => ps.reduce((s, p) => s + (p.kind === 'refund' ? -p.amount : p.amount), 0);
export const depositPaid = (ps: PaymentLike[]) => ps.filter((p) => (p.kind ?? 'deposit') === 'deposit').reduce((s, p) => s + p.amount, 0);

/** Lokma orqali kelgan bron: egasi to'lov yozmagan, lekin avans tasdiqlangan bo'lsa — avans to'langan hisoblanadi */
export function appBookingPayments(b: AppBookingLike): PaymentLike[] {
  if (b.payments?.length) return b.payments;
  if ((b.status === 'confirmed' || b.status === 'completed') && b.deposit > 0) {
    const at = b.paid_at ?? b.createdAt ?? new Date();
    return [{ _id: `app-${b._id}`, amount: b.deposit, kind: 'deposit', method: 'other', date: tashkentDate(at), note: 'Ilova orqali avans', at }];
  }
  return [];
}

export const reservationPayments = (r: ReservationLike) => r.payments ?? [];

/** Bosqich: ilovada saqlanganini ishlatadi, yo'q bo'lsa (eski/panel yozuvi) status va to'lovdan chiqaradi */
export function reservationStage(r: ReservationLike): Exclude<OwnerStatus, 'cancelled'> {
  if (r.status === 'tentative') return 'pending';
  if (r.stage === 'deposit' || r.stage === 'confirmed' || r.stage === 'completed') return r.stage;
  return netPaid(reservationPayments(r)) > 0 ? 'confirmed' : 'deposit';
}

const sessionTimes = (c: OwnerCtx, code: string) => {
  const s = c.venue.sessions.find((x) => x.code === code);
  return { start: s?.start_time ?? '', end: s?.end_time ?? '' };
};

export function paymentDto(p: PaymentLike) {
  const at = p.at ?? new Date(`${p.date}T09:00:00+05:00`);
  return {
    id: String(p._id), kind: (p.kind ?? 'deposit') as PayKind, amount: p.amount, method: p.method ?? 'cash',
    date: p.date, at: at.toISOString(), note: p.note ?? '',
  };
}

export interface OwnerBookingDto {
  id: string;
  source: 'owner' | 'app';
  number: string | null;
  status: OwnerStatus;
  date: string;
  session: string;
  session_label: string;
  start_time: string;
  end_time: string;
  event_type: string | null;
  event_label: string;
  hall_id: string;
  hall_name: string;
  guests: number;
  customer_name: string;
  customer_phone: string;
  address: string;
  notes: string;
  menu_id: string | null;
  menu_name: string | null;
  staff_ids: string[];
  extras: { name: string; type: string; price: number }[];
  hold_until: string | null;
  cancel_reason: string | null;
  created_at: string;
  /* Pul ma'lumotlari — faqat egasiga (xodimga server yubormaydi) */
  pricing_mode?: string;
  price_per_guest?: number;
  total?: number;
  deposit_paid?: number;
  paid?: number;
  balance?: number;
  payments?: ReturnType<typeof paymentDto>[];
}

function base(c: OwnerCtx, p: {
  id: Types.ObjectId; source: 'owner' | 'app'; number: string | null; status: OwnerStatus; date: string; session: string;
  start?: string | null; end?: string | null; event_type?: string | null; hall_id: Types.ObjectId; hall_name?: string | null;
  guests: number; name: string; phone: string; address?: string | null; notes?: string | null;
  menu_id?: string | null; menu_name?: string | null; staff?: Types.ObjectId[] | null; extras?: OwnerBookingDto['extras'];
  hold_until?: Date | null; cancel_reason?: string | null; created?: Date | null;
}): OwnerBookingDto {
  const tpl = sessionTimes(c, p.session);
  const hall = c.venue.halls.find((h) => String(h._id) === String(p.hall_id));
  return {
    id: String(p.id), source: p.source, number: p.number, status: p.status, date: p.date, session: p.session,
    session_label: SESSION_LABELS[p.session as keyof typeof SESSION_LABELS] ?? p.session,
    start_time: p.start || tpl.start, end_time: p.end || tpl.end,
    event_type: p.event_type ?? null, event_label: p.event_type ? EVENT_LABELS[p.event_type as EventTypeAll] ?? p.event_type : '',
    hall_id: String(p.hall_id), hall_name: p.hall_name || hall?.name || '',
    guests: p.guests, customer_name: p.name, customer_phone: normalizePhone(p.phone) ?? p.phone, address: p.address ?? '', notes: p.notes ?? '',
    menu_id: p.menu_id || null, menu_name: p.menu_name || null,
    staff_ids: (p.staff ?? []).map(String), extras: p.extras ?? [],
    hold_until: p.hold_until ? p.hold_until.toISOString() : null, cancel_reason: p.cancel_reason ?? null,
    created_at: (p.created ?? new Date()).toISOString(),
  };
}

function withMoney(dto: OwnerBookingDto, role: AppRole, m: { mode: string; ppg: number; total: number; payments: PaymentLike[] }): OwnerBookingDto {
  if (role !== 'owner') return dto; // xodim pulni ko'rmaydi — maydonlar umuman yuborilmaydi
  const paid = netPaid(m.payments);
  return {
    ...dto, pricing_mode: m.mode, price_per_guest: m.ppg, total: m.total, deposit_paid: depositPaid(m.payments),
    paid, balance: Math.max(0, m.total - paid), payments: m.payments.map(paymentDto).sort((a, b) => b.at.localeCompare(a.at)),
  };
}

export function reservationDto(c: OwnerCtx, r: ReservationLike, cancelled = false): OwnerBookingDto {
  const status: OwnerStatus = cancelled ? 'cancelled' : reservationStage(r);
  const dto = base(c, {
    id: r._id, source: 'owner', number: null, status, date: r.date, session: r.session, start: r.start_time, end: r.end_time,
    event_type: r.event_type, hall_id: r.hall_id, hall_name: r.hall_name, guests: r.guests ?? 0,
    name: r.customer_name || '', phone: r.customer_phone || '', address: r.address, notes: r.description,
    menu_id: r.menu_id, menu_name: r.menu_name, staff: r.staff_ids, cancel_reason: r.cancel_reason, created: r.createdAt,
  });
  return withMoney(dto, c.role, { mode: r.pricing_mode ?? 'per_guest', ppg: r.price_per_guest ?? 0, total: r.total_price ?? 0, payments: reservationPayments(r) });
}

export function appBookingDto(c: OwnerCtx, b: AppBookingLike): OwnerBookingDto {
  const dto = base(c, {
    id: b._id, source: 'app', number: b.number, status: b.status, date: b.date, session: b.session, event_type: b.event_type,
    hall_id: b.hall_id, hall_name: b.hall_name, guests: b.guests, name: b.customer_name, phone: b.customer_phone, notes: b.notes,
    menu_id: b.menu?.id, menu_name: b.menu?.name, staff: b.staff_ids, cancel_reason: b.cancel_reason, created: b.createdAt,
    hold_until: b.status === 'pending' ? b.hold_until : null,
    extras: (b.extras ?? []).map((e) => ({ name: e.name ?? '', type: e.type ?? '', price: e.price ?? 0 })),
  });
  return withMoney(dto, c.role, { mode: 'per_guest', ppg: b.price_per_guest, total: b.total, payments: appBookingPayments(b) });
}

export const isActiveStatus = (s: OwnerStatus) => s !== 'cancelled' && s !== 'completed';
