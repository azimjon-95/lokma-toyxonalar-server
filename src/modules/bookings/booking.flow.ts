import { addDaysISO, todayISO } from '../../lib/dates.js';
import { conflict, badRequest } from '../../lib/http-error.js';

/*
 * ═══ MIJOZ BRONI — EGASI TOMONIDAN BOSHQARISH (sof mantiq, bazasiz) ═══
 *
 * Oqim:
 *   Mijoz bron qiladi ─► NEW ("Yangi so'rov") ─► egasi ko'radi, telefon qilib gaplashadi
 *     ├─ rad etadi (sabab bilan) ─────────────────────► REJECTED
 *     ├─ "Kelishildi" (avans muddati bilan) ─► AGREED ─┐
 *     └─ avans olib keldi ◄────────────────────────────┘
 *            └─► CONFIRMED ("Tasdiqlandi", seans BAND, kirim yoziladi) ─► COMPLETED
 *   Muddat tugasa (avans kelmasa / javob berilmasa) ─► EXPIRED (seans bo'shaydi)
 *
 * Ma'lumotlar bazadagi `status` (pending|confirmed|cancelled|completed) + `stage` (new|agreed)
 * + `cancelled_by`/`rejected_at` dan hisoblanadi — eski bronlar o'zgarishsiz ishlaydi.
 */
export type OwnerState = 'new' | 'agreed' | 'confirmed' | 'completed' | 'rejected' | 'cancelled' | 'expired';
export type OwnerAction = 'seen' | 'agree' | 'reject' | 'advance' | 'confirm' | 'cancel';

export const REJECT_REASONS: Record<string, string> = {
  busy: 'Bu sana yoki vaqt mos emas',
  price: 'Narx bo‘yicha kelisha olmadik',
  guests: 'Mehmonlar soni mos emas',
  no_answer: 'Mijoz telefonga javob bermadi',
  declined: 'Mijoz o‘zi voz kechdi',
  other: 'Boshqa sabab',
};

/** Avans muddati: standart 3 kun, eng ko'pi bilan 30 kun */
export const DEFAULT_ADVANCE_DAYS = 3;
export const MAX_ADVANCE_DAYS = 30;

export interface FlowBooking {
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed';
  stage?: 'new' | 'agreed' | null;
  cancel_reason?: string | null;
  cancelled_by?: 'customer' | 'owner' | 'system' | null;
  rejected_at?: Date | null;
  hold_until?: Date | null;
}
export interface PayLike { amount: number; kind: 'deposit' | 'payment' | 'refund' }

export function ownerState(b: FlowBooking, now = new Date()): OwnerState {
  if (b.status === 'confirmed') return 'confirmed';
  if (b.status === 'completed') return 'completed';
  if (b.status === 'cancelled') {
    if (b.rejected_at) return 'rejected';
    if (b.cancel_reason === 'expired') return 'expired';
    return 'cancelled';
  }
  // pending: muddati o'tgan, lekin tozalash vazifasi hali ishlamagan bo'lishi mumkin
  if (b.hold_until && b.hold_until <= now) return 'expired';
  return b.stage === 'agreed' ? 'agreed' : 'new';
}

const ACTIONS: Record<OwnerState, OwnerAction[]> = {
  new: ['seen', 'agree', 'reject', 'advance', 'confirm'],
  agreed: ['agree', 'reject', 'advance', 'confirm'],
  confirmed: ['advance', 'cancel'],
  completed: [],
  rejected: [],
  cancelled: [],
  expired: [],
};
export const allowedActions = (state: OwnerState): OwnerAction[] => ACTIONS[state];

const STATE_UZ: Record<OwnerState, string> = {
  new: 'Yangi so‘rov', agreed: 'Kelishildi', confirmed: 'Tasdiqlandi', completed: 'Yakunlandi',
  rejected: 'Rad etildi', cancelled: 'Bekor qilindi', expired: 'Muddati tugadi',
};
export const stateLabel = (s: OwnerState) => STATE_UZ[s];

/** Amal shu holatda mumkinmi — bo'lmasa tushunarli xato */
export function assertAction(state: OwnerState, action: OwnerAction) {
  if (ACTIONS[state].includes(action)) return;
  const why = state === 'expired'
    ? 'Bu so‘rovning muddati tugagan, seans bo‘shatilgan'
    : state === 'confirmed' && (action === 'agree' || action === 'reject')
      ? 'Bron tasdiqlangan: bekor qilish uchun “Bekor qilish” ni tanlang'
      : `Bu bron hozir “${STATE_UZ[state]}” holatida — bu amalni bajarib bo‘lmaydi`;
  throw conflict(why, 'invalid_state');
}

/** "YYYY-MM-DD" kunining oxiri (Toshkent, +05:00) */
export const endOfDayTashkent = (iso: string) => new Date(`${iso}T23:59:59+05:00`);

/**
 * Avans muddati → ushlab turish tugash vaqti. `dueISO` bo'sh bo'lsa — standart (3 kun).
 * O'tgan sana yoki 30 kundan uzoq — xato.
 */
export function advanceDeadline(dueISO: string | undefined, now = new Date()): { dueISO: string; holdUntil: Date } {
  const today = todayISO(now);
  const iso = dueISO || addDaysISO(today, DEFAULT_ADVANCE_DAYS);
  if (iso < today) throw badRequest('Avans muddati o‘tgan sana bo‘lishi mumkin emas');
  if (iso > addDaysISO(today, MAX_ADVANCE_DAYS)) throw badRequest(`Avans muddati ${MAX_ADVANCE_DAYS} kundan oshmasin`);
  return { dueISO: iso, holdUntil: endOfDayTashkent(iso) };
}

export const paidOf = (payments: PayLike[] | undefined, legacyDeposit = 0, confirmed = false): number => {
  if (payments?.length) return payments.reduce((s, p) => s + (p.kind === 'refund' ? -p.amount : p.amount), 0);
  // Eski tasdiqlangan bronlarda alohida to'lov yozuvi yo'q — avans to'langan deb hisoblanadi
  return confirmed ? legacyDeposit : 0;
};

/** Kelishilgan jami (egasi o'zgartirgan bo'lsa) yoki dastlabki jami */
export const effectiveTotal = (total: number, agreedTotal?: number | null) =>
  typeof agreedTotal === 'number' && agreedTotal > 0 ? agreedTotal : total;

/** To'lov summasi tekshiruvi: musbat va qoldiqdan oshmasin */
export function checkPayment(totalEffective: number, paid: number, amount: number) {
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Summani kiriting');
  const left = Math.max(0, totalEffective - paid);
  if (totalEffective > 0 && amount > left) throw badRequest(`Summa qoldiqdan oshmasin: ${left}`, { max: left });
}

/** Tavsiya etilgan avans: bron yaratilganda hisoblangan zakalat */
export const suggestedAdvance = (deposit: number, totalEffective: number) =>
  Math.min(Math.max(0, deposit), totalEffective > 0 ? totalEffective : deposit);

/** Telefonda ko'rinadigan qisqa matn (SMS): lotin, qisqa, ASCII */
export function newBookingSms(b: { date: string; hall_name: string; guests: number; customer_name: string; customer_phone: string }, sessionLabel: string): string {
  const d = b.date.split('-').reverse().join('.');
  const name = b.customer_name.replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 24);
  return `LokmaGo: yangi bron so'rovi! ${d}, ${b.hall_name}, ${sessionLabel}, ${b.guests} mehmon. ${name} ${b.customer_phone}. Panelda koring.`;
}
