import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { forbidden, unauthorized } from '../../lib/http-error.js';
import { VenueModel } from '../venues/venue.model.js';
import { EmployeeModel, VenueAccountModel } from '../owner/owner.models.js';
import { verifyPassword } from '../owner/password.js';

/*
 * ═══ EGASI / XODIM MOBIL ILOVASI — AUTENTIFIKATSIYA ═══
 *
 * Ikki xil token (bir xil JWT_SECRET, `typ` bilan ajratiladi — Telegram tokeni bu yerda ishlamaydi):
 *   owner-login — parol to'g'ri bo'lgandan keyin 10 daqiqaga; rol tanlash uchun
 *   owner-app   — rol tanlangach uzoq muddatli; barcha so'rovlarda ishlatiladi
 *
 * Har so'rovda DB'dan tekshiriladi: hisob faol, to'yxona bloklanmagan, token_version mos —
 * admin bloklasa yoki parol almashsa, token darhol bekor bo'ladi.
 */
export type AppRole = 'owner' | 'staff';

export interface OwnerCtx {
  role: AppRole;
  subjectId: Types.ObjectId;
  venueId: Types.ObjectId;
  name: string;
  phone: string;
  venue: {
    _id: Types.ObjectId; name: string; status: string; block_reason?: string;
    halls: { _id: Types.ObjectId; name: string; capacity_min: number; capacity_max: number }[];
    sessions: { code: string; start_time: string; end_time: string }[];
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    owner?: OwnerCtx;
  }
}

interface RoleRef { role: AppRole; sub: string }

export const signLoginToken = (phone: string, roles: RoleRef[]) =>
  jwt.sign({ typ: 'owner-login', ph: phone, r: roles }, env.JWT_SECRET, { expiresIn: '10m' });

export const signAppToken = (p: { role: AppRole; sub: string; venueId: string; tv: number; phone: string }) =>
  jwt.sign({ typ: 'owner-app', role: p.role, sub: p.sub, vid: p.venueId, tv: p.tv, ph: p.phone }, env.JWT_SECRET, {
    expiresIn: env.OWNER_TOKEN_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });

export function bearer(req: Request): string {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw unauthorized();
  return h.slice(7);
}

export function verifyTyped<T extends object>(token: string, typ: string): T {
  try {
    const p = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
    if (p.typ !== typ) throw new Error('typ');
    return p as unknown as T;
  } catch {
    throw unauthorized('Sessiya muddati tugagan, qayta kiring');
  }
}

/** Telefon bo'yicha hisoblar (egasi akkaunti + xodim). `login` raqam bo'lsa ham mos keladi (admin yaratgan akkaunt) */
export async function findPrincipals(phoneE164: string) {
  const digits = phoneE164.replace(/\D/g, '');
  const tail = digits.slice(-9);
  const [owners, staff] = await Promise.all([
    VenueAccountModel.find({
      $or: [{ phone: phoneE164 }, { login: { $in: [digits, tail, phoneE164] } }],
      active: true,
    }).lean(),
    EmployeeModel.find({ app_phone: phoneE164, app_access: true, active: true }).lean(),
  ]);
  return { owners: owners.filter((o) => !o.deleted_at), staff };
}

/** Parol mos kelgan hisoblarning rollari */
export async function matchLogin(phoneE164: string, password: string) {
  const { owners, staff } = await findPrincipals(phoneE164);
  const matched: { role: AppRole; id: string; venueId: string; name: string }[] = [];
  for (const o of owners) {
    if (await verifyPassword(password, o.password_hash)) matched.push({ role: 'owner', id: String(o._id), venueId: String(o.venue_id), name: o.name || '' });
  }
  for (const e of staff) {
    if (e.password_hash && (await verifyPassword(password, e.password_hash))) matched.push({ role: 'staff', id: String(e._id), venueId: String(e.venue_id), name: e.name });
  }
  return matched;
}

const BLOCKED = (reason?: string) => forbidden(`To‘yxona bloklangan${reason ? `: ${reason}` : ''}`);

export async function loadCtx(role: AppRole, sub: string, tv: number): Promise<OwnerCtx> {
  if (!Types.ObjectId.isValid(sub)) throw unauthorized();
  let venueId: Types.ObjectId; let name = ''; let phone = '';
  if (role === 'owner') {
    const a = await VenueAccountModel.findById(sub).lean();
    if (!a || !a.active || a.deleted_at || (a.token_version ?? 0) !== tv) throw unauthorized('Akkaunt faol emas yoki sessiya tugagan');
    venueId = a.venue_id as Types.ObjectId; name = a.name || ''; phone = a.phone || '';
  } else {
    const e = await EmployeeModel.findById(sub).lean();
    if (!e || !e.active || !e.app_access || (e.token_version ?? 0) !== tv) throw unauthorized('Akkaunt faol emas yoki sessiya tugagan');
    venueId = e.venue_id as Types.ObjectId; name = e.name; phone = e.app_phone || '';
  }
  const venue = await VenueModel.findById(venueId, { name: 1, status: 1, block_reason: 1, halls: 1, sessions: 1, owner: 1 }).lean();
  if (!venue) throw unauthorized('To‘yxona topilmadi');
  if (venue.status === 'blocked') throw BLOCKED(venue.block_reason);
  if (role === 'owner' && !name) name = venue.owner?.name || 'To‘yxona egasi';
  return { role, subjectId: new Types.ObjectId(sub), venueId: venue._id as Types.ObjectId, name, phone, venue: venue as unknown as OwnerCtx['venue'] };
}

export async function ownerAppAuth(req: Request, _res: Response, next: NextFunction) {
  const p = verifyTyped<{ role: AppRole; sub: string; tv: number }>(bearer(req), 'owner-app');
  req.owner = await loadCtx(p.role, p.sub, p.tv ?? 0);
  next();
}

/** Faqat to'yxona egasi (moliya, menyu, xodimlar, rasmlar...) */
export function requireOwnerRole(req: Request, _res: Response, next: NextFunction) {
  if (req.owner?.role !== 'owner') throw forbidden('Bu amal faqat to‘yxona egasi uchun');
  next();
}

export const ctx = (req: Request) => req.owner!;
