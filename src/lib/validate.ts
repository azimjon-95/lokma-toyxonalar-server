import { z } from 'zod';
import { badRequest } from './http-error.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    const field = first?.path.join('.') || 'so‘rov';
    throw badRequest(`Noto‘g‘ri qiymat: ${field}`, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'ID noto‘g‘ri');
export const lat = z.coerce.number().min(-90).max(90);
export const lng = z.coerce.number().min(-180).max(180);
