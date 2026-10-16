import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/*
 * ═══ KESH QATLAMI ═══
 *   L1 — jarayon ichidagi xotira (mikrosekund);  L2 — Redis (barcha instance'lar uchun umumiy).
 *
 *   • VERSIYALANGAN KALIT: kalitga "versiya raqami" kiradi (venues / slots). Yozuvdan keyin raqam oshadi →
 *     eski kalitlar o'zi "yo'qoladi" (SCAN/DEL kerak emas) va yangi so'rov darhol yangi ma'lumotni yuklaydi.
 *   • SWR (stale-while-revalidate): muddati o'tgan, lekin hali "swr" ichidagi qiymat DARHOL qaytariladi,
 *     yangilash fonda ketadi — foydalanuvchi hech qachon loader'ni kutmaydi.
 *   • SINGLE-FLIGHT: bir kalit uchun bir vaqtda faqat bitta loader ishlaydi (bazaga bir xil so'rov to'planmaydi).
 *   • REDIS O'CHSA: so'rovlar uzilmaydi — L1 + loader'ga tushadi (5 s dan keyin qayta uriniladi).
 *
 *   Qaytgan qiymatlar UMUMIY havola — o'zgartirmang (faqat o'qing).
 */
export type Dep = 'venues' | 'slots';
export interface CacheOpts {
  /** Qiymat "yangi" turadigan vaqt (soniya) */
  ttl: number;
  /** Shundan keyin yana shuncha vaqt eskirgan qiymat ko'rsatilib, fonda yangilanadi (soniya) */
  swr?: number;
}

interface Envelope<T> { v: T; t: number; ttl: number; swr: number }

const gz = promisify(gzip);
const gunz = promisify(gunzip);
const P = env.CACHE_PREFIX;
const GZIP_OVER = 32 * 1024; // shundan katta qiymatlar Redis'ga siqilib yoziladi (tarmoq va xotira tejaladi)

/** Redis qiymati: 1 bayt belgi (0 — oddiy JSON, 1 — gzip) + ma'lumot */
async function encode(e: Envelope<unknown>): Promise<Buffer> {
  const raw = Buffer.from(JSON.stringify(e));
  return raw.length > GZIP_OVER ? Buffer.concat([Buffer.from([1]), await gz(raw)]) : Buffer.concat([Buffer.from([0]), raw]);
}
async function decode<T>(buf: Buffer): Promise<Envelope<T>> {
  const body = buf.subarray(1);
  return JSON.parse((buf[0] === 1 ? await gunz(body) : body).toString()) as Envelope<T>;
}
const L1_MAX = 600;
const l1 = new Map<string, Envelope<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const stats = { l1: 0, l2: 0, miss: 0, stale: 0, loads: 0, redisErrors: 0, bumps: 0 };

/* ── Redis ── */
let redis: Redis | null = null;
let downUntil = 0;
let fails = 0;
let lastErrLog = 0;

/** Redis'ga ulanadi. Ulanish tayyor bo'lguncha (yoki `waitMs` o'tguncha) kutadi — birinchi so'rovlar keshsiz qolmasin. */
export function initCache(url = env.REDIS_URL, waitMs = 1500): Promise<void> {
  if (!env.CACHE_ENABLED || redis || !url) return Promise.resolve();
  redis = new Redis(url, {
    enableOfflineQueue: false, // ulanish yo'q paytda buyruqlar navbatda turmaydi — darhol xato (keshsiz davom etamiz)
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 1000, // katta qiymatlar (snapshot) uchun yetarli; hot-path L1 dan, Redis kutilmaydi
    retryStrategy: (n) => Math.min(n * 250, 5000),
    lazyConnect: false,
  });
  redis.on('error', (e) => {
    stats.redisErrors++;
    if (Date.now() - lastErrLog > 30_000) { lastErrLog = Date.now(); logger.warn('Redis xatosi (kesh xotiraga o‘tdi)', { error: e.message }); }
  });
  const r = redis;
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, waitMs);
    r.once('ready', () => { clearTimeout(t); resolve(); });
    r.on('ready', () => { downUntil = 0; logger.info('Redis tayyor'); });
  });
}

async function safe<T>(fn: (c: Redis) => Promise<T>): Promise<T | undefined> {
  // Ulanish hali tayyor emas (ishga tushish / qayta ulanish) — jarima yo'q, keshsiz davom etamiz
  if (!redis || redis.status !== 'ready' || Date.now() < downUntil) return undefined;
  try {
    const r = await fn(redis);
    fails = 0;
    return r;
  } catch (e) {
    stats.redisErrors++;
    // Bitta timeout (masalan, katta yozuv) Redis'ni "o'chiq" qilmaydi — ketma-ket 3 xatodan keyin 5 s dam beramiz
    if (++fails >= 3) { downUntil = Date.now() + 5000; fails = 0; }
    if (Date.now() - lastErrLog > 30_000) { lastErrLog = Date.now(); logger.warn('Redis javob bermadi', { error: String(e) }); }
    return undefined;
  }
}

export async function closeCache() {
  const r = redis; redis = null;
  if (r) await r.quit().catch(() => r.disconnect());
}

/* ── Versiyalar ── */
const local: Record<Dep, number> = { venues: 1, slots: 1 };
let verMemo: { at: number; v: Record<Dep, number> } | null = null;
const VER_MEMO_MS = 1000; // boshqa instance'dagi bekor qilish shuncha vaqtda ko'rinadi

/** Redis'dagi raqam mahalliydan kichik bo'lsa — faqat yuqoriga ko'taradi (Lua, poyga xavfsiz) */
const MAX_LUA = "local v=tonumber(redis.call('GET',KEYS[1]) or '0'); if v<tonumber(ARGV[1]) then redis.call('SET',KEYS[1],ARGV[1]) end; return 1";
const DEPS: Dep[] = ['venues', 'slots'];

/*
 * Versiya MONOTON: mahalliy raqam hech qachon pasaymaydi. Redis uzilganda ham o'sishda davom etadi,
 * Redis qaytganda kattasi g'olib (kichik bo'lsa Redis'ga ko'tarib qo'yiladi). Aks holda uzilish paytida
 * raqam orqaga qaytib, eski kalitlar bilan to'qnashardi.
 */
async function versions(): Promise<Record<Dep, number>> {
  if (verMemo && Date.now() - verMemo.at < VER_MEMO_MS) return verMemo.v;
  const r = await safe((c) => c.mget(`${P}:ver:venues`, `${P}:ver:slots`));
  if (r) {
    DEPS.forEach((d, i) => {
      const rv = Number(r[i] ?? 0) || 0;
      if (rv > local[d]) local[d] = rv;
      else if (rv < local[d]) void safe((c) => c.eval(MAX_LUA, 1, `${P}:ver:${d}`, String(local[d])));
    });
  }
  verMemo = { at: Date.now(), v: { venues: local.venues, slots: local.slots } };
  return verMemo.v;
}

/** Ma'lumot o'zgardi: shu bog'liqlikdagi barcha kesh darhol eskiradi */
export function bump(dep: Dep) {
  if (!env.CACHE_ENABLED) return;
  stats.bumps++;
  local[dep] += 1;
  verMemo = null;
  void safe((c) => c.incr(`${P}:ver:${dep}`)).then((n) => { if (n) local[dep] = Math.max(local[dep], n); verMemo = null; });
  scheduleWarm();
}

/* ── Isitgichlar: bekor qilingandan keyin keshni oldindan qayta to'ldirish (birinchi foydalanuvchi kutmasin) ── */
const warmers = new Map<string, () => Promise<unknown>>();
let warmTimer: NodeJS.Timeout | undefined;
export function registerWarmer(name: string, fn: () => Promise<unknown>) { warmers.set(name, fn); }
function scheduleWarm() {
  if (env.NODE_ENV === 'test' || warmTimer) return;
  warmTimer = setTimeout(() => { warmTimer = undefined; void warmAll(); }, 250);
  warmTimer.unref?.();
}
export async function warmAll() {
  await Promise.allSettled([...warmers.values()].map((f) => f()));
}

/* ── Asosiy funksiya ── */
function l1Set(key: string, e: Envelope<unknown>) {
  if (l1.size >= L1_MAX) l1.delete(l1.keys().next().value as string); // eng eskisi
  l1.delete(key);
  l1.set(key, e);
}
const age = (e: Envelope<unknown>) => (Date.now() - e.t) / 1000;

export async function cached<T>(name: string, parts: string, opts: CacheOpts, loader: () => Promise<T>, deps: Dep[] = ['venues']): Promise<T> {
  if (!env.CACHE_ENABLED) return loader();
  const swr = opts.swr ?? 0;
  const ver = await versions();
  const key = `${P}:${name}:${deps.map((d) => ver[d]).join('.')}:${parts}`;

  const refresh = (): Promise<T> => {
    const running = inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = (async () => {
      stats.loads++;
      const v = await loader();
      const e: Envelope<T> = { v, t: Date.now(), ttl: opts.ttl, swr };
      l1Set(key, e);
      void encode(e).then((buf) => safe((c) => c.set(key, buf, 'EX', Math.ceil(opts.ttl + swr + 5))));
      return v;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  // L1
  const hit = l1.get(key) as Envelope<T> | undefined;
  if (hit) {
    const a = age(hit);
    if (a < hit.ttl) { stats.l1++; return hit.v; }
    if (a < hit.ttl + hit.swr) { stats.stale++; void refresh().catch(() => {}); return hit.v; }
  }
  // L2 (Redis)
  const raw = await safe((c) => c.getBuffer(key));
  if (raw) {
    try {
      const e = await decode<T>(raw);
      const a = age(e);
      if (a < e.ttl + e.swr) {
        l1Set(key, e);
        if (a < e.ttl) { stats.l2++; return e.v; }
        stats.stale++; void refresh().catch(() => {}); return e.v;
      }
    } catch { /* buzilgan yozuv — qayta yuklaymiz */ }
  }
  stats.miss++;
  return refresh();
}

/** Faqat testlar uchun: L1 (xotira) ni tozalaydi — L2 (Redis) o'z holicha qoladi */
export function clearL1ForTests() { l1.clear(); inflight.clear(); }

/** Qo'lda tozalash (masalan, bazaga to'g'ridan-to'g'ri yozilgandan keyin) */
export function flushAll() { bump('venues'); bump('slots'); l1.clear(); }

export function cacheStatus() {
  return {
    mode: !env.CACHE_ENABLED ? 'off' : redis ? 'redis' : 'memory',
    redis: !redis ? 'off' : redis.status === 'ready' && Date.now() >= downUntil ? 'ready' : 'down',
    l1_entries: l1.size,
    ...stats,
  };
}
