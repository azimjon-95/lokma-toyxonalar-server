import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError, badRequest, forbidden, unauthorized } from '../../lib/http-error.js';
import { normalizePhone } from '../../lib/phone.js';
import { parse } from '../../lib/validate.js';
import { logger } from '../../infrastructure/logger.js';
import { VenueModel } from '../venues/venue.model.js';
import { EmployeeModel, VenueAccountModel } from '../owner/owner.models.js';
import { hashPassword } from '../owner/password.js';
import { PasswordResetModel } from './owner-app.models.js';
import { sendSms } from './sms.service.js';
import {
  bearer, ctx, findPrincipals, loadCtx, matchLogin, ownerAppAuth, signAppToken, signLoginToken, verifyTyped, type AppRole,
} from './owner-app.auth.js';

export const authPublicRouter = Router();
export const authSecuredRouter = Router();

const PASSWORD = z.string().min(6, 'Parol kamida 6 ta belgi').max(100);
const phoneField = z.string().min(9).max(20).transform((s, c) => {
  const p = normalizePhone(s);
  if (!p) { c.addIssue({ code: 'custom', message: 'Telefon raqamini to‘liq kiriting' }); return z.NEVER; }
  return p;
});

const limiter = (limit: number, windowMs: number, key: (req: import('express').Request) => string) =>
  rateLimit({
    windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: (req) => key(req),
    message: { message: 'Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.', code: 'rate_limited' },
    // Testlar tez-tez kiradi; production'da o'chirib bo'lmaydi
    skip: () => env.NODE_ENV === 'test' && process.env.OWNER_APP_RATE_LIMIT_ON !== '1',
  });
const ipOf = (req: import('express').Request) => ipKeyGenerator(req.ip ?? '');
const phoneKey = (req: import('express').Request) => `${ipOf(req)}|${normalizePhone(String(req.body?.phone ?? '')) ?? 'x'}`;

/** POST /auth/login — telefon + parol → { token (rol tanlash uchun), roles } */
authPublicRouter.post('/login', limiter(10, 15 * 60_000, phoneKey), async (req, res) => {
  const b = parse(z.object({ phone: phoneField, password: z.string().min(1).max(200) }), req.body);
  const matched = await matchLogin(b.phone, b.password);
  // Bir xil javob: telefon yo'qmi yoki parol xatomi — oshkor qilinmaydi
  if (!matched.length) throw unauthorized('Telefon raqam yoki parol noto‘g‘ri');

  // Bloklangan to'yxona/hisob — parol to'g'ri bo'lgandan keyin sababi aytiladi
  const venues = await VenueModel.find({ _id: { $in: matched.map((m) => m.venueId) } }, { status: 1, block_reason: 1 }).lean();
  const live = matched.filter((m) => venues.find((v) => String(v._id) === m.venueId)?.status !== 'blocked');
  if (!live.length) {
    const v = venues[0];
    throw forbidden(`To‘yxona bloklangan${v?.block_reason ? `: ${v.block_reason}` : ''}`);
  }
  const roles = [...new Set(live.map((m) => m.role))] as AppRole[];
  await Promise.all([
    VenueAccountModel.updateMany({ _id: { $in: live.filter((m) => m.role === 'owner').map((m) => m.id) } }, { $set: { last_login_at: new Date() } }),
    EmployeeModel.updateMany({ _id: { $in: live.filter((m) => m.role === 'staff').map((m) => m.id) } }, { $set: { last_login_at: new Date() } }),
  ]);
  res.json({ token: signLoginToken(b.phone, live.map((m) => ({ role: m.role, sub: m.id }))), roles });
});

/** GET /auth/session?role= — kirish tokenini rol tokeniga almashtiradi; rol tokeni bilan — joriy sessiya (tekshiruv) */
authPublicRouter.get('/session', async (req, res) => {
  const token = bearer(req);
  const q = parse(z.object({ role: z.enum(['owner', 'staff']).optional() }), req.query);
  let role: AppRole; let sub: string; let tv: number; let phone: string;

  let login: { ph: string; r: { role: AppRole; sub: string }[] } | null = null;
  try { login = verifyTyped(token, 'owner-login'); } catch { /* app token bo'lishi mumkin */ }

  if (login) {
    const pick = login.r.find((x) => x.role === q.role) ?? (login.r.length === 1 ? login.r[0] : undefined);
    if (!pick) throw badRequest('Rolni tanlang');
    role = pick.role; sub = pick.sub; phone = login.ph;
    const c = await loadCtx(role, sub, await currentVersion(role, sub));
    tv = await currentVersion(role, sub);
    return void res.json(sessionBody(c, signAppToken({ role, sub, venueId: String(c.venueId), tv, phone })));
  }
  const p = verifyTyped<{ role: AppRole; sub: string; tv: number; ph: string }>(token, 'owner-app');
  const c = await loadCtx(p.role, p.sub, p.tv ?? 0);
  res.json(sessionBody(c, token));
});

async function currentVersion(role: AppRole, sub: string): Promise<number> {
  const d = role === 'owner' ? await VenueAccountModel.findById(sub, { token_version: 1 }).lean() : await EmployeeModel.findById(sub, { token_version: 1 }).lean();
  return d?.token_version ?? 0;
}

const sessionBody = (c: Awaited<ReturnType<typeof loadCtx>>, token: string) => ({
  token,
  user: { id: String(c.subjectId), phone: c.phone, name: c.name, role: c.role, venue_id: String(c.venueId), venue_name: c.venue.name },
});

/* ── Parolni tiklash ── */
const codeHash = (code: string, phone: string) => createHash('sha256').update(`${code}:${phone}:${env.JWT_SECRET}`).digest();
const RESET_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;

authPublicRouter.post('/forgot', limiter(3, 10 * 60_000, phoneKey), async (req, res) => {
  const b = parse(z.object({ phone: phoneField }), req.body);
  const { owners, staff } = await findPrincipals(b.phone);
  // Mavjud bo'lmasa ham bir xil javob (telefon ro'yxatdan o'tganini oshkor qilmaymiz)
  const body: { ok: true; ttl_seconds: number; dev_code?: string } = { ok: true, ttl_seconds: RESET_TTL_MIN * 60 };
  if (owners.length || staff.length) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await PasswordResetModel.deleteMany({ phone: b.phone });
    await PasswordResetModel.create({ phone: b.phone, code_hash: codeHash(code, b.phone).toString('hex'), expires_at: new Date(Date.now() + RESET_TTL_MIN * 60_000) });
    const { delivered } = await sendSms(b.phone, env.SMS_TEMPLATE.replace('{code}', code));
    if (!delivered && env.NODE_ENV !== 'production') body.dev_code = code; // faqat dev/test
  }
  res.json(body);
});

authPublicRouter.post('/reset', limiter(10, 10 * 60_000, phoneKey), async (req, res) => {
  const b = parse(z.object({ phone: phoneField, code: z.string().regex(/^\d{4,8}$/, 'SMS kod noto‘g‘ri'), password: PASSWORD }), req.body);
  const bad = () => new HttpError(400, 'SMS kod noto‘g‘ri yoki muddati tugagan', 'invalid_code');
  const r = await PasswordResetModel.findOne({ phone: b.phone });
  if (!r || r.expires_at <= new Date()) throw bad();
  if (r.attempts >= MAX_ATTEMPTS) {
    await r.deleteOne();
    throw new HttpError(429, 'Juda ko‘p noto‘g‘ri urinish. Yangi kod so‘rang.', 'too_many_attempts');
  }
  const given = codeHash(b.code, b.phone);
  const expected = Buffer.from(r.code_hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    r.attempts += 1; await r.save();
    throw bad();
  }
  const hash = await hashPassword(b.password);
  const { owners, staff } = await findPrincipals(b.phone);
  await Promise.all([
    VenueAccountModel.updateMany({ _id: { $in: owners.map((o) => o._id) } }, { $set: { password_hash: hash }, $inc: { token_version: 1 } }),
    EmployeeModel.updateMany({ _id: { $in: staff.map((e) => e._id) } }, { $set: { password_hash: hash }, $inc: { token_version: 1 } }),
  ]);
  await r.deleteOne();
  logger.info('Parol tiklandi', { owners: owners.length, staff: staff.length });
  res.json({ ok: true });
});

/** DELETE /account — hisobni o'chirish (App Store talabi). To'yxona ma'lumotlari saqlanadi. */
authSecuredRouter.delete('/account', ownerAppAuth, async (req, res) => {
  const c = ctx(req);
  if (c.role === 'owner') {
    await VenueAccountModel.updateOne({ _id: c.subjectId }, { $set: { active: false, deleted_at: new Date() }, $inc: { token_version: 1 } });
  } else {
    await EmployeeModel.updateOne({ _id: c.subjectId }, { $set: { app_access: false, password_hash: '' }, $inc: { token_version: 1 } });
  }
  logger.info('Ilova hisobi o‘chirildi', { role: c.role, venue: String(c.venueId) });
  res.json({ ok: true });
});
