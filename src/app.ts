import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { rateLimit } from 'express-rate-limit';
import mongoose from 'mongoose';
import { env, isProd } from './config/env.js';
import { HttpError } from './lib/http-error.js';
import { logger } from './infrastructure/logger.js';
import { venueRouter, hallRouter } from './modules/venues/venue.routes.js';
import { quoteRouter, bookingRouter, meRouter } from './modules/bookings/booking.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { ownerRouter, internalRouter } from './modules/owner/owner.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // nginx / load balancer ortida

  app.use(helmet());
  /*
   * Mijoz sayti (wedding.lokma.uz) DOIM ruxsat etilgan: .env'da CORS_ORIGINS
   * bo'sh yoki unutilgan bo'lsa ham sayt (va Lokma Go ichidagi iframe) ishlaydi —
   * aks holda brauzer so'rovni to'sadi va mijoz "Internetga ulanib bo'lmadi" ko'radi.
   */
  const origins = [...new Set(['https://wedding.lokma.uz', ...env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)])];
  app.use(cors({ origin: isProd ? origins : true, credentials: false }));
  app.use(compression());
  app.use(express.json({ limit: '200kb' }));

  if (!isProd) {
    app.use((req, res, next) => {
      const t = Date.now();
      res.on('finish', () => logger.debug(`${req.method} ${req.originalUrl}`, { status: res.statusCode, ms: Date.now() - t }));
      next();
    });
  }

  app.use('/api/health', healthRouter);
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000, limit: env.API_RATE_LIMIT, standardHeaders: 'draft-8', legacyHeaders: false,
      message: { message: 'Juda ko‘p so‘rov', code: 'rate_limited' },
      // lakmago-server orqali (admin + barcha to'yxona egalari bitta IP dan) — umumiy limitga kirmaydi.
      // Kalit noto'g'ri bo'lsa baribir requireAdmin rad etadi.
      skip: (req) => Boolean(env.ADMIN_API_KEY) && req.headers['x-admin-key'] === env.ADMIN_API_KEY,
    }),
  );
  app.use('/api/auth', authRouter);
  app.use('/api/venues', venueRouter);
  app.use('/api/halls', hallRouter);
  app.use('/api/quote', quoteRouter);
  app.use('/api/bookings', bookingRouter);
  app.use('/api/me', meRouter);
  app.use('/api/admin', adminRouter);
  // To'yxona egasi CRM va ichki login — faqat lakmago-server orqali (X-Admin-Key)
  app.use('/api/owner', ownerRouter);
  app.use('/api/internal', internalRouter);

  app.use((_req, res) => {
    res.status(404).json({ message: 'Endpoint topilmadi', code: 'not_found' });
  });

  // Express 5: async xatolar ham shu yerga keladi
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ message: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
      return;
    }
    if (err instanceof mongoose.Error.ValidationError) {
      res.status(422).json({ message: 'Ma’lumot noto‘g‘ri', code: 'validation', details: Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })) });
      return;
    }
    if ((err as { code?: number })?.code === 11000) {
      res.status(409).json({ message: 'Bunday yozuv allaqachon mavjud', code: 'duplicate' });
      return;
    }
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ message: 'JSON noto‘g‘ri', code: 'bad_json' });
      return;
    }
    logger.error('Kutilmagan xato', { path: req.originalUrl, error: err instanceof Error ? err.stack : String(err) });
    res.status(500).json({ message: 'Serverda xatolik. Birozdan keyin qayta urinib ko‘ring.', code: 'internal' });
  });

  return app;
}
