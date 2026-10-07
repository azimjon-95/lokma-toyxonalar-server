import { env } from '../config/env.js';

export type SessionCode = 'morning' | 'day' | 'evening' | 'special';
/** Kalendar tartibi — maxsus tadbir oxirida (lib/sessions.ts) */
export const SESSION_ORDER: SessionCode[] = ['morning', 'day', 'evening', 'special'];
/** Bo'sh seans qidirilganda ustuvorlik (to'ylar asosan kechqurun) */
export const SESSION_PREFERENCE: SessionCode[] = ['evening', 'day', 'morning'];

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: env.TZ_NAME, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Toshkent vaqti bo'yicha bugungi sana YYYY-MM-DD */
export const todayISO = (now = new Date()) => fmt.format(now);

export function addDaysISO(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Shanba yoki yakshanba */
export function isWeekendISO(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 || wd === 6;
}

export function monthDays(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

export const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
