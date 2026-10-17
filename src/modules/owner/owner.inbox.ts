import type { Request, Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { ISO_DATE, todayISO } from '../../lib/dates.js';
import { conflict, notFound } from '../../lib/http-error.js';
import { SESSION_LABELS, type SessionCodeAll } from '../../lib/sessions.js';
import { objectId, parse } from '../../lib/validate.js';
import { BookingModel } from '../bookings/booking.model.js';
import {
  REJECT_REASONS, advanceDeadline, allowedActions, assertAction, checkPayment, effectiveTotal, ownerState,
  paidOf, stateLabel, suggestedAdvance, type OwnerAction,
} from '../bookings/booking.flow.js';
import { markBooked, releaseByBooking } from '../slots/slot.service.js';
import { SlotModel } from '../slots/slot.model.js';
import { PAY_METHODS, TransactionModel } from './owner.models.js';
import { OwnerNotificationModel } from './owner.notifications.js';

/*
 * ═══ EGASI: MIJOZ BRONLARI (so'rovlar qutisi) ═══
 * GET  /inbox/summary                — belgi uchun: o'qilmagan bildirishnomalar va holat sonlari (polling)
 * GET  /inbox?state=…                — ro'yxat (to'liq ma'lumot bilan)
 * GET  /inbox/:id                    — bitta bron (tarix, to'lovlar, mumkin amallar)
 * POST /inbox/:id/seen|agree|reject|advance|confirm|cancel
 * GET  /notifications, POST /notifications/read
 * Egalik: hamma so'rov venue_id bilan cheklangan (owner.routes.ts middleware'i qo'yadi).
 */
type OwnerReq = Request & { venueId?: Types.ObjectId };
type AnyBooking = Record<string, any> & { _id: Types.ObjectId };

const now = () => new Date();
const tl = (kind: string, text: string) => ({ at: now(), kind, text });
const money = (n: number) => Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ');

export function bookingDto(b: AnyBooking) {
  const state = ownerState(b as never);
  const payments = ((b.payments ?? []) as { _id?: Types.ObjectId; amount: number; method: string; kind: 'deposit' | 'payment' | 'refund'; date: string; note?: string; at?: Date }[])
    .map((p) => ({ id: p._id ? String(p._id) : undefined, amount: p.amount, method: p.method, kind: p.kind, date: p.date, note: p.note ?? '', at: p.at }));
  const total = effectiveTotal(b.total, b.agreed_total);
  const paid = paidOf(payments, b.deposit, b.status === 'confirmed' || b.status === 'completed');
  return {
    id: String(b._id), number: b.number, state, state_label: stateLabel(state), status: b.status,
    actions: allowedActions(state),
    customer: { name: b.customer_name, phone: b.customer_phone },
    venue_name: b.venue_name, hall_id: String(b.hall_id), hall_name: b.hall_name,
    date: b.date, session: b.session, session_label: SESSION_LABELS[b.session as SessionCodeAll] ?? b.session,
    event_type: b.event_type, guests: b.guests,
    menu: b.menu?.name ? { name: b.menu.name, price_per_guest: b.menu.price_per_guest } : null,
    extras: (b.extras ?? []).map((e: { name?: string; type?: string; price?: number }) => ({ name: e.name, type: e.type, price: e.price })),
    price_per_guest: b.price_per_guest, venue_total: b.venue_total,
    total: b.total, agreed_total: b.agreed_total ?? null, total_effective: total,
    deposit_suggested: suggestedAdvance(b.deposit, total), paid, balance: Math.max(0, total - paid), payments,
    hold_until: b.hold_until, advance_due: b.advance_due ?? null,
    agreed_note: b.agreed_note ?? '', reject_reason: b.reject_reason ?? '', cancel_reason: b.cancel_reason ?? '',
    notes: b.notes ?? '',
    created_at: b.createdAt, seen_at: b.owner_seen_at ?? null, confirmed_at: b.confirmed_at ?? null, agreed_at: b.agreed_at ?? null,
    timeline: (b.timeline ?? []).map((t: { at: Date; kind: string; text: string }) => ({ at: t.at, kind: t.kind, text: t.text })),
  };
}

async function load(req: OwnerReq, id: string): Promise<AnyBooking> {
  const b = await BookingModel.findOne({ _id: id, venue_id: req.venueId }).lean();
  if (!b) throw notFound('Bron topilmadi');
  return b as AnyBooking;
}
const idOf = (req: Request) => parse(z.object({ id: objectId }), req.params).id;
const act = (b: AnyBooking, a: OwnerAction) => assertAction(ownerState(b as never), a);
const markRead = (venueId: Types.ObjectId, bookingId: Types.ObjectId) =>
  OwnerNotificationModel.updateMany({ venue_id: venueId, booking_id: bookingId, read_at: { $exists: false } }, { $set: { read_at: now() } }).catch(() => {});
const fresh = async (req: OwnerReq, id: string) => bookingDto(await load(req, id));

/** Ro'yxat filtrlari (muddati o'tgan kutilayotganlar chiqarilmaydi — ular "expired") */
function filterOf(venueId: Types.ObjectId, state: string, today: string, at: Date): Record<string, unknown> {
  const base = { venue_id: venueId };
  const pend = { status: 'pending', hold_until: { $gt: at } };
  switch (state) {
    case 'new': return { ...base, ...pend, stage: { $ne: 'agreed' } };
    case 'agreed': return { ...base, ...pend, stage: 'agreed' };
    case 'confirmed': return { ...base, status: 'confirmed', date: { $gte: today } };
    case 'history': return { ...base, $or: [{ status: { $in: ['cancelled', 'completed'] } }, { status: 'confirmed', date: { $lt: today } }, { status: 'pending', hold_until: { $lte: at } }] };
    default: return { ...base, $or: [{ status: { $ne: 'pending' } }, { status: 'pending', hold_until: { $gt: at } }] };
  }
}

async function counts(venueId: Types.ObjectId) {
  const today = todayISO(); const at = now();
  const [n, a, c] = await Promise.all(['new', 'agreed', 'confirmed'].map((s) => BookingModel.countDocuments(filterOf(venueId, s, today, at))));
  return { new: n, agreed: a, confirmed: c };
}

const reasonText = (code: string, note: string) => (code === 'other' ? note : REJECT_REASONS[code]) + (code !== 'other' && note ? ` — ${note}` : '');

export function registerInboxRoutes(r: Router) {
  /* ── belgi uchun yengil so'rov ── */
  r.get('/inbox/summary', async (req: OwnerReq, res) => {
    const [unread, c, latest] = await Promise.all([
      OwnerNotificationModel.countDocuments({ venue_id: req.venueId, read_at: { $exists: false } }),
      counts(req.venueId!),
      OwnerNotificationModel.findOne({ venue_id: req.venueId }, { createdAt: 1 }).sort({ createdAt: -1 }).lean(),
    ]);
    res.json({ unread, counts: c, latest_at: latest?.createdAt ?? null });
  });

  r.get('/inbox', async (req: OwnerReq, res) => {
    const f = parse(z.object({ state: z.enum(['new', 'agreed', 'confirmed', 'history', 'all']).default('new'), limit: z.coerce.number().int().min(1).max(200).default(100) }), req.query);
    const today = todayISO(); const at = now();
    const sort: Record<string, 1 | -1> = f.state === 'agreed' ? { advance_due: 1 } : f.state === 'confirmed' ? { date: 1 } : { createdAt: -1 };
    const [items, c] = await Promise.all([
      BookingModel.find(filterOf(req.venueId!, f.state, today, at)).sort(sort).limit(f.limit).lean(),
      counts(req.venueId!),
    ]);
    res.json({ counts: c, items: items.map((b) => bookingDto(b as AnyBooking)) });
  });

  r.get('/inbox/:id', async (req: OwnerReq, res) => {
    res.json(await fresh(req, idOf(req)));
  });

  /* ── ko'rdim ── */
  r.post('/inbox/:id/seen', async (req: OwnerReq, res) => {
    const b = await load(req, idOf(req));
    if (!b.owner_seen_at && b.status === 'pending') {
      await BookingModel.updateOne({ _id: b._id, owner_seen_at: { $exists: false } }, { $set: { owner_seen_at: now() }, $push: { timeline: tl('seen', 'To‘yxona so‘rovni ko‘rdi') } });
    }
    await markRead(req.venueId!, b._id);
    res.json(await fresh(req, String(b._id)));
  });

  /* ── Kelishildi: telefonda gaplashildi, avans muddati belgilanadi ── */
  r.post('/inbox/:id/agree', async (req: OwnerReq, res) => {
    const id = idOf(req);
    const body = parse(z.object({
      note: z.string().max(500).default(''), advance_due: z.string().regex(ISO_DATE).optional(),
      agreed_total: z.number().int().min(0).max(100_000_000_000).optional(),
    }), req.body);
    const b = await load(req, id); act(b, 'agree');
    const { holdUntil } = advanceDeadline(body.advance_due);
    const upd = await BookingModel.findOneAndUpdate(
      { _id: b._id, venue_id: req.venueId, status: 'pending' },
      {
        $set: {
          stage: 'agreed', agreed_at: now(), agreed_note: body.note, advance_due: holdUntil, hold_until: holdUntil,
          ...(body.agreed_total !== undefined ? { agreed_total: body.agreed_total } : {}), owner_seen_at: b.owner_seen_at ?? now(),
        },
        $push: { timeline: tl('agreed', `Kelishildi · avans muddati ${holdUntil.toISOString().slice(0, 10).split('-').reverse().join('.')}${body.agreed_total !== undefined ? ` · jami ${money(body.agreed_total)} so‘m` : ''}${body.note ? ` · ${body.note}` : ''}`) },
      },
      { new: true },
    ).lean();
    if (!upd) throw conflict('Bron holati o‘zgargan, yangilang', 'invalid_state');
    // Seans avans muddatigacha ushlab turiladi (aks holda 24 soatda bo'shab ketardi)
    await SlotModel.updateOne({ booking_id: b._id, status: 'hold' }, { $set: { hold_until: holdUntil } });
    await markRead(req.venueId!, b._id);
    res.json(bookingDto(upd as AnyBooking));
  });

  /* ── Rad etish (sabab majburiy; mijoz "Bronlarim"da ko'radi) ── */
  r.post('/inbox/:id/reject', async (req: OwnerReq, res) => {
    const id = idOf(req);
    const body = parse(z.object({ reason_code: z.enum(Object.keys(REJECT_REASONS) as [string, ...string[]]), note: z.string().max(300).default('') }), req.body);
    if (body.reason_code === 'other' && body.note.trim().length < 3) throw conflict('Sababni qisqacha yozing', 'reason_required');
    const b = await load(req, id); act(b, 'reject');
    const reason = reasonText(body.reason_code, body.note.trim());
    const upd = await BookingModel.findOneAndUpdate(
      { _id: b._id, venue_id: req.venueId, status: 'pending' },
      { $set: { status: 'cancelled', cancel_reason: 'owner_rejected', cancelled_by: 'owner', rejected_at: now(), reject_reason: reason },
        $push: { timeline: tl('rejected', `Rad etildi: ${reason}`) } },
      { new: true },
    ).lean();
    if (!upd) throw conflict('Bron holati o‘zgargan, yangilang', 'invalid_state');
    await releaseByBooking(b._id);
    await markRead(req.venueId!, b._id);
    res.json(bookingDto(upd as AnyBooking));
  });

  /* ── Avans olib keldi → tasdiqlandi (seans BAND, kirim yoziladi). Tasdiqlangan bronga qo'shimcha to'lov ham ── */
  r.post('/inbox/:id/advance', async (req: OwnerReq, res) => {
    const id = idOf(req);
    const body = parse(z.object({
      amount: z.number().int().positive().max(100_000_000_000), method: z.enum(PAY_METHODS).default('cash'),
      date: z.string().regex(ISO_DATE).optional(), note: z.string().max(200).default(''),
    }), req.body);
    const b = await load(req, id); act(b, 'advance');
    const isFirst = b.status === 'pending';
    const payments = (b.payments ?? []) as { amount: number; kind: 'deposit' | 'payment' | 'refund' }[];
    const paid = paidOf(payments, b.deposit, b.status === 'confirmed' || b.status === 'completed');
    checkPayment(effectiveTotal(b.total, b.agreed_total), paid, body.amount);
    if (isFirst) { // muddat tugab seans boshqaga o'tib ketmaganini tekshiramiz
      const slot = await SlotModel.findOne({ booking_id: b._id, status: { $in: ['hold', 'booked'] } }, { _id: 1 }).lean();
      if (!slot) throw conflict('Muddat tugagan: seans bo‘shatilgan', 'invalid_state');
    }
    const date = body.date ?? todayISO();
    const entry = { _id: new Types.ObjectId(), amount: body.amount, method: body.method, kind: isFirst ? 'deposit' : 'payment', date, note: body.note, at: now() };
    // Eski tasdiqlangan bronda yozuv yo'q bo'lsa — avans aniq yozuvga aylantiriladi (hisob o'zgarmaydi)
    const legacy = !payments.length && b.status === 'confirmed' && b.deposit > 0
      ? [{ _id: new Types.ObjectId(), amount: b.deposit, method: 'other', kind: 'deposit', date: b.date, note: 'Ilovadagi avans', at: b.paid_at ?? b.createdAt }] : [];
    const upd = await BookingModel.findOneAndUpdate(
      { _id: b._id, venue_id: req.venueId, status: isFirst ? 'pending' : 'confirmed' },
      {
        $push: {
          payments: { $each: [...legacy, entry] },
          timeline: tl(isFirst ? 'advance' : 'payment', `${isFirst ? 'Avans' : 'To‘lov'} qabul qilindi: ${money(body.amount)} so‘m${body.note ? ` · ${body.note}` : ''}`),
        },
        ...(isFirst ? { $set: { status: 'confirmed', confirmed_at: now(), paid_at: now(), owner_seen_at: b.owner_seen_at ?? now() }, $unset: { advance_due: 1 } } : {}),
      },
      { new: true },
    ).lean();
    if (!upd) throw conflict('Bron holati o‘zgargan, yangilang', 'invalid_state');
    if (isFirst) {
      await markBooked(b._id);
      await BookingModel.updateOne({ _id: b._id }, { $push: { timeline: tl('confirmed', 'Bron tasdiqlandi — seans band qilindi') } });
    }
    // Kirim-chiqim: avtomatik kirim (egasi qo'lda qayta yozmasin)
    await TransactionModel.create({
      venue_id: req.venueId, type: 'income', category: 'bron', amount: body.amount, date, method: body.method,
      note: `${isFirst ? 'Avans' : 'To‘lov'} · ${b.customer_name} · ${b.hall_name} · ${b.date.split('-').reverse().join('.')}`, booking_id: b._id,
    });
    await markRead(req.venueId!, b._id);
    res.json(await fresh(req, String(b._id)));
  });

  /* ── Avanssiz tasdiqlash (masalan to'liq to'lov keyin yoki ishonchli mijoz) ── */
  r.post('/inbox/:id/confirm', async (req: OwnerReq, res) => {
    const id = idOf(req);
    const body = parse(z.object({ note: z.string().max(300).default('') }), req.body ?? {});
    const b = await load(req, id); act(b, 'confirm');
    const slot = await SlotModel.findOne({ booking_id: b._id, status: { $in: ['hold', 'booked'] } }, { _id: 1 }).lean();
    if (!slot) throw conflict('Muddat tugagan: seans bo‘shatilgan', 'invalid_state');
    const upd = await BookingModel.findOneAndUpdate(
      { _id: b._id, venue_id: req.venueId, status: 'pending' },
      { $set: { status: 'confirmed', confirmed_at: now(), owner_seen_at: b.owner_seen_at ?? now() }, $unset: { advance_due: 1 },
        $push: { timeline: tl('confirmed', `Avanssiz tasdiqlandi — seans band qilindi${body.note ? ` · ${body.note}` : ''}`) } },
      { new: true },
    ).lean();
    if (!upd) throw conflict('Bron holati o‘zgargan, yangilang', 'invalid_state');
    await markBooked(b._id);
    await markRead(req.venueId!, b._id);
    res.json(bookingDto(upd as AnyBooking));
  });

  /* ── Tasdiqlangan bronni bekor qilish (sabab majburiy) ── */
  r.post('/inbox/:id/cancel', async (req: OwnerReq, res) => {
    const id = idOf(req);
    const body = parse(z.object({ reason_code: z.enum(Object.keys(REJECT_REASONS) as [string, ...string[]]), note: z.string().max(300).default('') }), req.body);
    if (body.reason_code === 'other' && body.note.trim().length < 3) throw conflict('Sababni qisqacha yozing', 'reason_required');
    const b = await load(req, id); act(b, 'cancel');
    const reason = reasonText(body.reason_code, body.note.trim());
    const paid = paidOf((b.payments ?? []) as never, b.deposit, true);
    const upd = await BookingModel.findOneAndUpdate(
      { _id: b._id, venue_id: req.venueId, status: 'confirmed' },
      { $set: { status: 'cancelled', cancel_reason: 'owner_cancelled', cancelled_by: 'owner', reject_reason: reason },
        $push: { timeline: tl('cancelled', `Bekor qilindi: ${reason}${paid > 0 ? ` · to‘langan ${money(paid)} so‘m (qaytarishni rasmiylashtiring)` : ''}`) } },
      { new: true },
    ).lean();
    if (!upd) throw conflict('Bron holati o‘zgargan, yangilang', 'invalid_state');
    await releaseByBooking(b._id);
    res.json(bookingDto(upd as AnyBooking));
  });

  /* ── bildirishnomalar ── */
  r.get('/notifications', async (req: OwnerReq, res) => {
    const f = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
    const [items, unread] = await Promise.all([
      OwnerNotificationModel.find({ venue_id: req.venueId }).sort({ createdAt: -1 }).limit(f.limit).lean(),
      OwnerNotificationModel.countDocuments({ venue_id: req.venueId, read_at: { $exists: false } }),
    ]);
    res.json({ unread, items: items.map((n) => ({ id: String(n._id), kind: n.kind, booking_id: n.booking_id ? String(n.booking_id) : null, title: n.title, body: n.body, read: Boolean(n.read_at), at: n.createdAt })) });
  });
  r.post('/notifications/read', async (req: OwnerReq, res) => {
    const b = parse(z.object({ ids: z.array(objectId).max(100).optional() }), req.body ?? {});
    await OwnerNotificationModel.updateMany(
      { venue_id: req.venueId, read_at: { $exists: false }, ...(b.ids ? { _id: { $in: b.ids } } : {}) },
      { $set: { read_at: now() } },
    );
    res.json({ ok: true });
  });
}
