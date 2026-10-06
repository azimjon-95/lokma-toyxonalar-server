import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  HOST: z.string().default('0.0.0.0'),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/lokma_toyxonalar'),
  /** Vergul bilan: https://lokma.uz,https://web.telegram.org. Bo'sh = hammasiga ruxsat (faqat dev) */
  CORS_ORIGINS: z.string().default(''),
  JWT_SECRET: z.string().min(16).default('dev-only-secret-change-me-please'),
  JWT_EXPIRES_IN: z.string().default('30d'),
  /** Telegram initData imzosini tekshirish uchun */
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  /** Admin API kaliti: X-Admin-Key sarlavhasi */
  ADMIN_API_KEY: z.string().default(''),
  /** Bron qilinganda seans necha daqiqa ushlab turiladi (TZ: 30) */
  HOLD_MINUTES: z.coerce.number().int().positive().default(30),
  /** Sana hisoblash uchun vaqt zonasi */
  TZ_NAME: z.string().default('Asia/Tashkent'),
  /** Telegram'dan kelmagan (oddiy ilova) bronlarga ruxsat */
  /** Bitta IP dan 10 daqiqada nechta bron so'rovi */
  BOOKING_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  /** Bitta IP dan daqiqada umumiy so'rovlar */
  API_RATE_LIMIT: z.coerce.number().int().positive().default(300),
  ALLOW_ANONYMOUS_BOOKING: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Noto‘g‘ri .env sozlamalari:', z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

if (isProd) {
  const problems: string[] = [];
  if (env.JWT_SECRET.startsWith('dev-only')) problems.push('JWT_SECRET');
  if (!env.ADMIN_API_KEY || env.ADMIN_API_KEY.length < 24) problems.push('ADMIN_API_KEY (kamida 24 belgi)');
  if (problems.length) {
    console.error(`Production uchun sozlang: ${problems.join(', ')}`);
    process.exit(1);
  }
}
