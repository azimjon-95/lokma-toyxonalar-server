import { Types } from 'mongoose';
import { addDaysISO, todayISO } from '../../lib/dates.js';
import { conflict, notFound, badRequest } from '../../lib/http-error.js';
import { normalizePhone } from '../../lib/phone.js';
import { BookingModel } from '../bookings/booking.model.js';
import {
  CancelledReservationModel, EmployeeModel, ReservationModel, TransactionModel, EXPENSE_CATEGORIES, INCOME_CATEGORIES,
} from '../owner/owner.models.js';
import { hashPassword } from '../owner/password.js';
import { listBookings } from './owner-app.bookings.js';
import { appBookingPayments, isActiveStatus, reservationPayments, type AppBookingLike, type PaymentLike, type ReservationLike } from './owner-app.dto.js';
import type { OwnerCtx } from './owner-app.auth.js';

/*
 * ═══ MOLIYA ═══
 * Daromad = qabul qilingan to'lovlar (zakalat + to'lov − qaytarish) + boshqa kirimlar.
 * Manbalar: egasi bronlari, Lokma ilovasi bronlari, bekor qilingan bronlar (olingan pul yo'qolmaydi) va
 * kirim-chiqim yozuvlari. Hammasi shu faylda — bosh sahifa, moliya va bron tafsiloti bir xil raqamni ko'rsatadi.
 */
export const EXPENSE_LABELS: Record<string, string> = {
  ish_haqi: 'ish haqi', oziq_ovqat: 'oziq-ovqat mahsulotlari', kommunal: 'kommunal', soliq: 'soliq', kredit: 'kredit',
  ijara_tolov: 'ijara', tamir: 'ta‘mir', jihoz: 'jihoz', reklama: 'reklama', transport: 'transport', boshqa: 'boshqa',
};
export const INCOME_LABELS: Record<string, string> = { bron: 'Bron', xizmat: 'Xizmat', ijara: 'Ijara', boshqa_kirim: 'Boshqa kirim' };
const PAY_TITLE: Record<string, string> = { deposit: 'Zakalat', payment: 'To‘lov', refund: 'Qaytarish' };

export interface Operation {
  id: string;
  /** deposit | income | expense | refund — ilovadagi TransactionType (+refund) */
  type: 'deposit' | 'income' | 'expense' | 'refund';
  title: string;
  subtitle: string;
  amount: number;
  at: string;
  date: string;
  method: string;
  booking_id: string | null;
  category: string | null;
  deletable: boolean;
}

const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const monthOf = (iso: string) => iso.slice(0, 7);
const prevMonth = (m: string) => { const [y, mm] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mm - 2, 1)); return d.toISOString().slice(0, 7); };
const range = (m: string) => ({ $gte: `${m}-01`, $lte: `${m}-31` });

/** Oraliqdagi barcha bron to'lovlari (yagona manba) */
async function paymentOps(c: OwnerCtx, from: string, to: string): Promise<Operation[]> {
  const q = { venue_id: c.venueId, 'payments.date': { $gte: from, $lte: to } };
  const fromD = new Date(`${from}T00:00:00+05:00`); const toD = new Date(`${addDaysISO(to, 1)}T00:00:00+05:00`);
  const [resv, cancelled, apps] = await Promise.all([
    ReservationModel.find(q).lean(),
    CancelledReservationModel.find(q).lean(),
    // Ilova avansi to'lov yozuvisiz tasdiqlangan bo'lsa ham hisobga olinadi (paid_at bo'yicha)
    BookingModel.find({ venue_id: c.venueId, $or: [{ 'payments.date': { $gte: from, $lte: to } }, { paid_at: { $gte: fromD, $lt: toD } }] }).lean(),
  ]);
  const ops: Operation[] = [];
  const push = (ps: PaymentLike[], bookingId: Types.ObjectId, client: string) => {
    for (const p of ps) {
      if (p.date < from || p.date > to) continue;
      const kind = p.kind ?? 'deposit';
      ops.push({
        id: String(p._id), type: kind === 'deposit' ? 'deposit' : kind === 'refund' ? 'refund' : 'income',
        title: PAY_TITLE[kind] ?? 'To‘lov', subtitle: client, amount: p.amount, at: (p.at ?? new Date(`${p.date}T09:00:00+05:00`)).toISOString(),
        date: p.date, method: p.method ?? 'cash', booking_id: String(bookingId), category: null, deletable: false,
      });
    }
  };
  for (const r of [...resv, ...cancelled] as unknown as ReservationLike[]) push(reservationPayments(r), r._id, r.customer_name || '');
  for (const b of apps as unknown as AppBookingLike[]) {
    if (b.status === 'cancelled' && !b.payments?.length) continue;
    push(appBookingPayments(b), b._id, b.customer_name);
  }
  return ops;
}

async function transactionOps(c: OwnerCtx, from: string, to: string): Promise<Operation[]> {
  const tx = await TransactionModel.find({ venue_id: c.venueId, date: { $gte: from, $lte: to } }).sort({ date: -1, createdAt: -1 }).limit(1000).lean();
  return tx.map((t) => ({
    id: String(t._id), type: t.type === 'income' ? ('income' as const) : ('expense' as const),
    title: t.type === 'income' ? INCOME_LABELS[t.category] ?? 'Kirim' : `Xarajat (${EXPENSE_LABELS[t.category] ?? t.category})`,
    subtitle: [t.employee_name, t.note].filter(Boolean).join(' · '), amount: t.amount,
    at: ((t as unknown as { createdAt?: Date }).createdAt ?? new Date(`${t.date}T12:00:00+05:00`)).toISOString(),
    date: t.date, method: t.method ?? 'cash', booking_id: null, category: t.category, deletable: true,
  }));
}

export async function operations(c: OwnerCtx, month: string, type?: 'income' | 'expense') {
  const from = `${month}-01`; const to = `${month}-31`;
  const [pays, tx] = await Promise.all([paymentOps(c, from, to), transactionOps(c, from, to)]);
  let all = [...pays, ...tx].sort((a, b) => b.at.localeCompare(a.at));
  if (type === 'income') all = all.filter((o) => o.type === 'deposit' || o.type === 'income');
  if (type === 'expense') all = all.filter((o) => o.type === 'expense' || o.type === 'refund');
  return all;
}

const net = (ops: Operation[]) => ops.reduce((s, o) => s + (o.type === 'refund' || o.type === 'expense' ? 0 : o.amount) - (o.type === 'refund' ? o.amount : 0), 0);

/** Bosh sahifa va Moliya ekrani uchun barcha ko'rsatkichlar */
export async function overview(c: OwnerCtx, now = new Date()) {
  const today = ymd(now);
  const month = monthOf(today); const prev = prevMonth(month);
  const yesterday = addDaysISO(today, -1);
  const [cur, prv, active] = await Promise.all([
    operations(c, month), operations(c, prev),
    listBookings(c, { from: '2000-01-01', to: '2100-01-01', limit: 5000 }),
  ]);
  const incomeOps = cur.filter((o) => o.type !== 'expense');
  const revenue = net(incomeOps);
  const deposit = incomeOps.filter((o) => o.type === 'deposit').reduce((s, o) => s + o.amount, 0);
  const prevRevenue = net(prv.filter((o) => o.type !== 'expense'));
  const dayIncome = (d: string) => net(cur.concat(prv).filter((o) => o.type !== 'expense' && o.date === d));
  const dueSoon = active.filter((b) => isActiveStatus(b.status) && (b.balance ?? 0) > 0);
  const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
  const todayIncome = dayIncome(today); const yIncome = dayIncome(yesterday);
  const upcoming = dueSoon.filter((b) => b.date >= today);
  return {
    month, today,
    revenue, deposit, paid: revenue - deposit,
    expenses: cur.filter((o) => o.type === 'expense').reduce((s, o) => s + o.amount, 0),
    remaining: dueSoon.reduce((s, b) => s + (b.balance ?? 0), 0),
    growth_percent: pct(revenue, prevRevenue),
    today_income: todayIncome, today_growth_percent: pct(todayIncome, yIncome),
    expected: upcoming.reduce((s, b) => s + (b.balance ?? 0), 0), expected_clients: upcoming.length,
  };
}

/* ═══ KIRIM-CHIQIM ═══ */
export type PayMethod = 'cash' | 'card' | 'transfer' | 'click' | 'payme' | 'other';
export interface TxInput { type: 'income' | 'expense'; category: string; amount: number; date?: string; method?: PayMethod; note?: string; employee_id?: string }

export async function addTransaction(c: OwnerCtx, i: TxInput) {
  const valid = (i.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES) as readonly string[];
  if (!valid.includes(i.category)) throw badRequest('Kategoriya noto‘g‘ri');
  let employee_name: string | undefined;
  if (i.employee_id) {
    const e = await EmployeeModel.findOne({ _id: i.employee_id, venue_id: c.venueId }, { name: 1 }).lean();
    if (!e) throw notFound('Ishchi topilmadi');
    employee_name = e.name;
  }
  const t = await TransactionModel.create({ ...i, date: i.date ?? todayISO(), method: i.method ?? 'cash', note: i.note ?? '', venue_id: c.venueId, employee_name });
  return (await transactionOps(c, t.date, t.date)).find((o) => o.id === String(t._id))!;
}

export async function deleteTransaction(c: OwnerCtx, id: string) {
  const t = await TransactionModel.findOneAndDelete({ _id: id, venue_id: c.venueId }).lean();
  if (!t) throw notFound('Yozuv topilmadi');
  return { ok: true };
}

/* ═══ ISHCHILAR ═══ */
export interface EmployeeInput {
  name: string; phone?: string; position?: string; pay_type?: 'daily' | 'monthly' | 'per_event'; rate?: number; hired_at?: string; note?: string;
  active?: boolean; app_access?: boolean; app_password?: string;
}

type EmpLean = {
  _id: Types.ObjectId; name: string; phone?: string; position?: string; pay_type?: string; rate?: number; hired_at?: string; note?: string;
  active?: boolean; app_access?: boolean; app_phone?: string; last_login_at?: Date;
};
const empDto = (e: EmpLean, paid: number, events: number) => ({
  id: String(e._id), name: e.name, phone: e.phone ?? '', position: e.position ?? '', pay_type: e.pay_type ?? 'monthly', rate: e.rate ?? 0,
  hired_at: e.hired_at ?? '', note: e.note ?? '', active: e.active !== false, app_access: !!e.app_access, app_phone: e.app_phone ?? '',
  paid_this_month: paid, events_count: events,
});

export async function listEmployees(c: OwnerCtx, activeOnly = false) {
  const month = monthOf(todayISO());
  const [list, paid] = await Promise.all([
    EmployeeModel.find({ venue_id: c.venueId, ...(activeOnly ? { active: { $ne: false } } : {}) }).sort({ active: -1, name: 1 }).lean(),
    TransactionModel.aggregate([
      { $match: { venue_id: c.venueId, type: 'expense', category: 'ish_haqi', date: range(month), employee_id: { $exists: true } } },
      { $group: { _id: '$employee_id', sum: { $sum: '$amount' } } },
    ]),
  ]);
  const by = new Map(paid.map((p) => [String(p._id), p.sum as number]));
  return Promise.all(list.map(async (e) => {
    const [a, b] = await Promise.all([
      ReservationModel.countDocuments({ venue_id: c.venueId, staff_ids: e._id }),
      BookingModel.countDocuments({ venue_id: c.venueId, staff_ids: e._id, status: { $ne: 'cancelled' } }),
    ]);
    return empDto(e as unknown as EmpLean, by.get(String(e._id)) ?? 0, a + b);
  }));
}

/** Ilovaga kirish telefoni: boshqa to'yxona xodimida takrorlanmasin */
async function checkAppPhone(phone: string, selfId?: Types.ObjectId) {
  const dup = await EmployeeModel.exists({ app_phone: phone, app_access: true, ...(selfId ? { _id: { $ne: selfId } } : {}) });
  if (dup) throw conflict('Bu telefon raqam boshqa xodimga ilovaga kirish uchun biriktirilgan', 'duplicate_phone');
}

export async function createEmployee(c: OwnerCtx, i: EmployeeInput) {
  const set: Record<string, unknown> = {
    venue_id: c.venueId, name: i.name, phone: i.phone ?? '', position: i.position ?? '', pay_type: i.pay_type ?? 'monthly', rate: i.rate ?? 0,
    hired_at: i.hired_at ?? '', note: i.note ?? '', active: i.active ?? true,
  };
  if (i.app_access) {
    const phone = normalizePhone(i.phone ?? '');
    if (!phone) throw badRequest('Ilovaga kirish uchun to‘liq telefon raqam kerak');
    if (!i.app_password || i.app_password.length < 6) throw badRequest('Parol kamida 6 ta belgi bo‘lsin');
    await checkAppPhone(phone);
    Object.assign(set, { app_access: true, app_phone: phone, password_hash: await hashPassword(i.app_password) });
  }
  const e = await EmployeeModel.create(set);
  return empDto(e.toObject() as unknown as EmpLean, 0, 0);
}

export async function updateEmployee(c: OwnerCtx, id: string, i: Partial<EmployeeInput>) {
  const e = await EmployeeModel.findOne({ _id: id, venue_id: c.venueId });
  if (!e) throw notFound('Ishchi topilmadi');
  for (const k of ['name', 'phone', 'position', 'pay_type', 'rate', 'hired_at', 'note', 'active'] as const) if (i[k] !== undefined) (e as unknown as Record<string, unknown>)[k] = i[k];
  const wantsAccess = i.app_access ?? e.app_access;
  if (wantsAccess) {
    const phone = normalizePhone(i.phone ?? e.phone ?? '');
    if (!phone) throw badRequest('Ilovaga kirish uchun to‘liq telefon raqam kerak');
    if (!e.password_hash && !i.app_password) throw badRequest('Parol kamida 6 ta belgi bo‘lsin');
    if (i.app_password !== undefined) {
      if (i.app_password.length < 6) throw badRequest('Parol kamida 6 ta belgi bo‘lsin');
      e.password_hash = await hashPassword(i.app_password); e.token_version = (e.token_version ?? 0) + 1;
    }
    await checkAppPhone(phone, e._id as Types.ObjectId);
    e.app_access = true; e.app_phone = phone;
  } else if (i.app_access === false) {
    e.app_access = false; e.password_hash = ''; e.token_version = (e.token_version ?? 0) + 1;
  }
  if (i.active === false) { e.app_access = false; e.token_version = (e.token_version ?? 0) + 1; }
  await e.save();
  const [a, b] = await Promise.all([
    ReservationModel.countDocuments({ venue_id: c.venueId, staff_ids: e._id }),
    BookingModel.countDocuments({ venue_id: c.venueId, staff_ids: e._id, status: { $ne: 'cancelled' } }),
  ]);
  return empDto(e.toObject() as unknown as EmpLean, 0, a + b);
}

/** O'chirish — yumshoq: ishchi nofaol bo'ladi, eski bronlar va hisobotlar saqlanadi */
export async function removeEmployee(c: OwnerCtx, id: string) {
  const e = await EmployeeModel.findOneAndUpdate({ _id: id, venue_id: c.venueId }, { $set: { active: false, app_access: false, password_hash: '' }, $inc: { token_version: 1 } }).lean();
  if (!e) throw notFound('Ishchi topilmadi');
  return { ok: true };
}
