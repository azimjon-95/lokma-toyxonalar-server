import { env, isProd } from '../../config/env.js';
import { HttpError } from '../../lib/http-error.js';
import { logger } from '../../infrastructure/logger.js';

/*
 * SMS yuborish (parolni tiklash kodi).
 *   SMS_PROVIDER=eskiz → Eskiz.uz (ESKIZ_EMAIL / ESKIZ_PASSWORD / ESKIZ_FROM)
 *   SMS_PROVIDER=none  → faqat dev/test: kod logga yoziladi (production'da xato qaytariladi)
 */
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let httpFetch: FetchLike = (url, init) => fetch(url, init);
export const setSmsFetch = (f: FetchLike | null) => { httpFetch = f ?? ((url, init) => fetch(url, init)); };

let eskizToken: { value: string; at: number } | null = null;
export const resetSmsCache = () => { eskizToken = null; };

async function eskizAuth(force = false): Promise<string> {
  if (!force && eskizToken && Date.now() - eskizToken.at < 20 * 24 * 3600_000) return eskizToken.value;
  const res = await httpFetch('https://notify.eskiz.uz/api/auth/login', {
    method: 'POST',
    body: new URLSearchParams({ email: env.ESKIZ_EMAIL, password: env.ESKIZ_PASSWORD }),
    signal: AbortSignal.timeout(8000),
  });
  const j = (await res.json().catch(() => ({}))) as { data?: { token?: string } };
  if (!res.ok || !j.data?.token) throw new Error(`Eskiz login ${res.status}`);
  eskizToken = { value: j.data.token, at: Date.now() };
  return eskizToken.value;
}

export async function sendSms(phoneE164: string, text: string): Promise<{ delivered: boolean }> {
  if (env.SMS_PROVIDER === 'eskiz') {
    const mobile = phoneE164.replace(/\D/g, '');
    const send = async (token: string) => httpFetch('https://notify.eskiz.uz/api/message/sms/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: new URLSearchParams({ mobile_phone: mobile, message: text, from: env.ESKIZ_FROM }),
      signal: AbortSignal.timeout(8000),
    });
    try {
      let res = await send(await eskizAuth());
      if (res.status === 401) res = await send(await eskizAuth(true)); // token eskirgan
      if (!res.ok) throw new Error(`Eskiz send ${res.status}`);
      return { delivered: true };
    } catch (e) {
      logger.error('SMS yuborilmadi', { error: String(e) });
      throw new HttpError(502, 'SMS yuborib bo‘lmadi. Birozdan keyin qayta urinib ko‘ring.', 'sms_failed');
    }
  }
  if (isProd) throw new HttpError(503, 'SMS xizmati sozlanmagan. Administrator bilan bog‘laning.', 'sms_not_configured');
  logger.info('SMS (dev, yuborilmadi)', { to: phoneE164, text });
  return { delivered: false };
}
