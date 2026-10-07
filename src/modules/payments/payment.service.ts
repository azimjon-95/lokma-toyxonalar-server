import { Types } from 'mongoose';
import { PaymentModel } from './payment.model.js';
import { VenueModel } from '../venues/venue.model.js';
import { todayISO } from '../../lib/dates.js';

/** 'YYYY-MM' + n oy → 'YYYY-MM' */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM' oyining oxirgi kuni → 'YYYY-MM-DD' */
export function lastDayOf(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(d).padStart(2, '0')}`;
}

/**
 * paid_until — eng uzoq qoplangan oyning oxirgi kuni. To'lovlar orasida
 * bo'shliq bo'lsa ham eng oxirgisi olinadi (qarzdorlik alohida ko'rsatiladi).
 */
export async function recalcPaidUntil(venueId: Types.ObjectId | string): Promise<string> {
  const rows = await PaymentModel.find({ venue_id: venueId }, { period_from: 1, months: 1 }).lean();
  let last = '';
  for (const r of rows) {
    const end = addMonths(r.period_from, r.months - 1);
    if (end > last) last = end;
  }
  const paidUntil = last ? lastDayOf(last) : '';
  await VenueModel.updateOne({ _id: venueId }, { $set: { 'subscription.paid_until': paidUntil } });
  return paidUntil;
}

export type SubState = 'free' | 'paid' | 'due_soon' | 'overdue' | 'never';

/**
 * Obuna holati:
 *   free     — oylik to'lov belgilanmagan (0)
 *   never    — to'lov hali bo'lmagan
 *   overdue  — paid_until o'tib ketgan (qarzdor oylar soni bilan)
 *   due_soon — 7 kun ichida tugaydi
 *   paid     — to'langan
 */
export function subscriptionState(sub: { monthly_fee?: number | null; paid_until?: string | null; billing_start?: string | null } | null | undefined, today = todayISO()) {
  const fee = sub?.monthly_fee ?? 0;
  const paidUntil = sub?.paid_until || '';
  if (!fee) return { state: 'free' as SubState, debt_months: 0, debt_amount: 0, days_left: null as number | null };
  const thisMonth = today.slice(0, 7);
  if (!paidUntil) {
    const start = sub?.billing_start || thisMonth;
    const months = Math.max(0, monthsBetween(start, thisMonth) + 1);
    return { state: 'never' as SubState, debt_months: months, debt_amount: months * fee, days_left: null };
  }
  const daysLeft = Math.round((Date.parse(paidUntil) - Date.parse(today)) / 86_400_000);
  if (daysLeft < 0) {
    const months = Math.max(1, monthsBetween(paidUntil.slice(0, 7), thisMonth));
    return { state: 'overdue' as SubState, debt_months: months, debt_amount: months * fee, days_left: daysLeft };
  }
  return { state: (daysLeft <= 7 ? 'due_soon' : 'paid') as SubState, debt_months: 0, debt_amount: 0, days_left: daysLeft };
}

function monthsBetween(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb * 12 + mb) - (ya * 12 + ma);
}
