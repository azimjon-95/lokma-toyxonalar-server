import { createHash, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/http-error.js';
import { logger } from '../../infrastructure/logger.js';

/*
 * ═══ CLOUDINARY ═══
 *
 * Oqim (server rasm baytlarini ko'rmaydi — trafik va xotira tejaladi):
 *   1) Ilova  → POST /uploads/sign        — server imzolangan yuklash chiptasini beradi
 *   2) Ilova  → Cloudinary (multipart)    — chipta maydonlari + file
 *   3) Ilova  → POST /venue/photos ...    — public_id'ni ro'yxatdan o'tkazadi
 *   4) Server public_id egasi shu to'yxona ekanini (prefiks) va rasm mavjudligini tekshiradi,
 *      URL'ni O'ZI quradi (mijoz yuborgan URL'ga ishonilmaydi).
 *
 * public_id tuzilishi: <folder>/venues/<venueId>/<kind>/<random> — to'yxona boshqa
 * to'yxonaning rasmini ro'yxatdan o'tkaza olmaydi.
 */

export type UploadKind = 'gallery' | 'dishes' | 'menus';
export type ImageVariant = 'thumb' | 'card' | 'large';

/** Yuklashga ruxsat etilgan formatlar (imzoga kiradi — mijoz o'zgartira olmaydi) */
export const ALLOWED_FORMATS = 'jpg,jpeg,png,webp,heic,heif';

/** Cloudinary yetkazish transformatsiyalari (f_auto: brauzerga mos format, q_auto: sifat) */
export const VARIANTS: Record<ImageVariant, string> = {
  thumb: 'c_fill,g_auto,w_240,h_240,f_auto,q_auto',
  card: 'c_limit,w_900,f_auto,q_auto',
  large: 'c_limit,w_1600,f_auto,q_auto',
};

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
}

export const cloudinaryConfig = (): CloudinaryConfig => ({
  cloudName: env.CLOUDINARY_CLOUD_NAME,
  apiKey: env.CLOUDINARY_API_KEY,
  apiSecret: env.CLOUDINARY_API_SECRET,
  folder: env.CLOUDINARY_FOLDER,
});

export const isCloudinaryConfigured = (c = cloudinaryConfig()) => Boolean(c.cloudName && c.apiKey && c.apiSecret);

export function requireCloudinary(c = cloudinaryConfig()) {
  if (!isCloudinaryConfigured(c)) {
    throw new HttpError(503, 'Rasm yuklash sozlanmagan. Administrator bilan bog‘laning.', 'cloudinary_not_configured');
  }
  return c;
}

/** Cloudinary imzosi: parametrlar alifbo tartibida "k=v&k=v" + api_secret, SHA-1 */
export function signParams(params: Record<string, string | number | boolean>, apiSecret: string): string {
  const payload = Object.keys(params)
    .filter((k) => !['file', 'cloud_name', 'resource_type', 'api_key', 'signature'].includes(k))
    .filter((k) => params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(payload + apiSecret).digest('hex');
}

export const venuePrefix = (venueId: string, c = cloudinaryConfig()) => `${c.folder}/venues/${venueId}`;
export const applicationPrefix = (c = cloudinaryConfig()) => `${c.folder}/applications`;

export interface UploadTicket {
  upload_url: string;
  cloud_name: string;
  public_id: string;
  /** Ilova aynan shu maydonlarni FormData'ga qo'shib, `file` bilan yuboradi */
  fields: Record<string, string>;
  expires_in: number;
}

/** Imzolangan yuklash chiptasi. `prefix` — public_id papkasi (venuePrefix/<kind> yoki applicationPrefix) */
export function createUploadTicket(prefix: string, c = requireCloudinary(), now = Date.now()): UploadTicket {
  const publicId = `${prefix}/${randomBytes(9).toString('base64url')}`;
  const timestamp = Math.floor(now / 1000);
  const signed = {
    allowed_formats: ALLOWED_FORMATS,
    overwrite: 'false', // tasodifiy public_id bo'lsa ham, mavjud rasmni ustidan yozib yubormaymiz
    public_id: publicId,
    timestamp,
  };
  return {
    upload_url: `https://api.cloudinary.com/v1_1/${c.cloudName}/image/upload`,
    cloud_name: c.cloudName,
    public_id: publicId,
    fields: {
      api_key: c.apiKey,
      timestamp: String(timestamp),
      public_id: publicId,
      allowed_formats: ALLOWED_FORMATS,
      overwrite: 'false',
      signature: signParams(signed, c.apiSecret),
    },
    expires_in: 3600, // Cloudinary imzoni ~1 soat qabul qiladi
  };
}

export interface ImageAsset {
  public_id: string;
  version?: number;
  width?: number;
  height?: number;
  bytes?: number;
  format?: string;
}

/** public_id mos prefiksga tegishli ekanini tekshiradi ("..", ortiqcha segmentlar yo'q) */
export function assertOwnedPublicId(publicId: string, prefix: string) {
  const ok = typeof publicId === 'string' && publicId.startsWith(`${prefix}/`) && /^[A-Za-z0-9_\-/]+$/.test(publicId)
    && !publicId.includes('//') && publicId.slice(prefix.length + 1).split('/').length === 1;
  if (!ok) throw new HttpError(422, 'Rasm identifikatori noto‘g‘ri', 'validation');
}

/** Rasm URL'ini serverning o'zi quradi */
export function imageUrl(asset: Pick<ImageAsset, 'public_id' | 'version'>, variant: ImageVariant = 'large', c = cloudinaryConfig()): string {
  const v = asset.version ? `v${asset.version}/` : '';
  return `https://res.cloudinary.com/${c.cloudName}/image/upload/${VARIANTS[variant]}/${v}${asset.public_id}`;
}

/** Mavjud URL'ni boshqa o'lchamga o'tkazadi (faqat Cloudinary yetkazish URL'lari uchun) */
export function resizeUrl(url: string, variant: ImageVariant): string {
  if (!url.includes('res.cloudinary.com') || !url.includes('/image/upload/')) return url;
  return url.replace(/\/image\/upload\/[^/]*(?:f_auto|q_auto|w_\d+)[^/]*\//, `/image/upload/${VARIANTS[variant]}/`);
}

/* ── Cloudinary bilan server tomonidagi so'rovlar (testda almashtiriladi) ── */
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
let httpFetch: FetchLike = (url, init) => fetch(url, init);
export const setCloudinaryFetch = (f: FetchLike | null) => { httpFetch = f ?? ((url, init) => fetch(url, init)); };

const shouldVerify = () => env.CLOUDINARY_VERIFY === 'true' || (env.CLOUDINARY_VERIFY === 'auto' && isCloudinaryConfigured());

/** Rasm haqiqatan yuklanganini tekshiradi va metama'lumotni oladi (Admin API) */
export async function verifyAsset(publicId: string, c = requireCloudinary()): Promise<ImageAsset> {
  if (!shouldVerify()) return { public_id: publicId };
  const auth = Buffer.from(`${c.apiKey}:${c.apiSecret}`).toString('base64');
  let res: Response;
  try {
    res = await httpFetch(`https://api.cloudinary.com/v1_1/${c.cloudName}/resources/image/upload/${publicId}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    logger.warn('Cloudinary tekshiruvi ishlamadi', { error: String(e) });
    throw new HttpError(502, 'Rasm xizmati javob bermadi. Qayta urinib ko‘ring.', 'cloudinary_unreachable');
  }
  if (res.status === 404) throw new HttpError(422, 'Rasm yuklanmagan. Qaytadan yuklang.', 'asset_missing');
  if (!res.ok) throw new HttpError(502, 'Rasm xizmati xatosi', 'cloudinary_error');
  const j = (await res.json()) as { public_id: string; version?: number; width?: number; height?: number; bytes?: number; format?: string };
  return { public_id: j.public_id, version: j.version, width: j.width, height: j.height, bytes: j.bytes, format: j.format };
}

/** Rasmni Cloudinary'dan o'chiradi (xatolik DB amalini to'xtatmaydi — faqat log) */
export async function destroyAsset(publicId: string, c = cloudinaryConfig(), now = Date.now()): Promise<boolean> {
  if (!isCloudinaryConfigured(c)) return false;
  const timestamp = Math.floor(now / 1000);
  const body = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    api_key: c.apiKey,
    invalidate: 'true',
    signature: signParams({ invalidate: 'true', public_id: publicId, timestamp }, c.apiSecret),
  });
  try {
    const res = await httpFetch(`https://api.cloudinary.com/v1_1/${c.cloudName}/image/destroy`, {
      method: 'POST', body, signal: AbortSignal.timeout(8000),
    });
    const j = (await res.json().catch(() => ({}))) as { result?: string };
    if (!res.ok || (j.result !== 'ok' && j.result !== 'not found')) {
      logger.warn('Cloudinary destroy muvaffaqiyatsiz', { publicId, status: res.status, result: j.result });
      return false;
    }
    return true;
  } catch (e) {
    logger.warn('Cloudinary destroy xatosi', { publicId, error: String(e) });
    return false;
  }
}
