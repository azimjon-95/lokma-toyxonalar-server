import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { forbidden, unauthorized } from '../../lib/http-error.js';

export interface AuthUser {
  id: string;
  telegram_id: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export const signToken = (u: AuthUser) =>
  jwt.sign({ sub: u.id, tg: u.telegram_id }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] });

function readUser(req: Request): AuthUser | undefined {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return undefined;
  try {
    const p = jwt.verify(h.slice(7), env.JWT_SECRET) as jwt.JwtPayload;
    return p.sub ? { id: String(p.sub), telegram_id: Number(p.tg) } : undefined;
  } catch {
    throw unauthorized('Sessiya muddati tugagan, qayta kiring');
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  req.user = readUser(req);
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  req.user = readUser(req);
  if (!req.user) throw unauthorized();
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const given = Buffer.from(String(req.headers['x-admin-key'] ?? ''));
  const expected = Buffer.from(env.ADMIN_API_KEY);
  if (!env.ADMIN_API_KEY || given.length !== expected.length || !timingSafeEqual(given, expected)) throw forbidden('Admin kaliti noto‘g‘ri');
  next();
}
