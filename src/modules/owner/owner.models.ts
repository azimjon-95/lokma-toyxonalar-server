import { Schema, model, type InferSchemaType } from 'mongoose';
import { SESSION_CODES, EVENT_TYPES, PRICING_MODES } from '../../lib/sessions.js';

/*
 * ═══ TO'YXONA EGASI (CRM) — modellari ═══
 * Hammasi venue_id bilan bog'langan: egasi faqat o'z to'yxonasini ko'radi
 * (owner.routes.ts — venue_id so'rovdan emas, ishonchli sarlavhadan olinadi).
 */

/** Egasining kirish ma'lumoti (LokmaGo admin paneli login sahifasi orqali kiradi) */
const accountSchema = new Schema(
  {
    venue_id: { type: Schema.Types.ObjectId, ref: 'Venue', required: true, unique: true },
    login: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password_hash: { type: String, required: true },
    active: { type: Boolean, default: true },
    last_login_at: { type: Date },
    /* Mobil ilova (lokma-toyxona-owner): telefon + parol bilan kiradi. E.164: +998XXXXXXXXX.
     * Bir telefon bitta hisobga tegishli — admin/ilova xizmatlari tekshiradi. */
    phone: { type: String, default: '', index: true },
    name: { type: String, default: '', trim: true },
    /** Parol almashganda/hisob o'chirilganda oshadi — eski tokenlar darhol bekor bo'ladi */
    token_version: { type: Number, default: 0 },
    deleted_at: { type: Date },
  },
  { timestamps: true },
);
export const VenueAccountModel = model('VenueAccount', accountSchema);

export const PAY_METHODS = ['cash', 'card', 'transfer', 'click', 'payme', 'other'] as const;

/**
 * Egasi kalendarda band qilgan seans (telefon orqali kelgan mijoz, maxsus tadbir...).
 * Slot bilan sinxron: yaratilganda seans band bo'ladi — ilovada ham "band" ko'rinadi.
 */
const reservationFields = {
    venue_id: { type: Schema.Types.ObjectId, ref: 'Venue', required: true, index: true },
    hall_id: { type: Schema.Types.ObjectId, required: true },
    hall_name: { type: String, default: '' },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    session: { type: String, enum: SESSION_CODES, required: true },
    /** booked — tasdiqlangan; tentative — kelishilmoqda (vaqtincha ushlab turiladi); closed — yopiq (ta'mir va h.k.) */
    status: { type: String, enum: ['booked', 'tentative', 'closed'], default: 'booked' },
    /*
     * Egasi ilovasidagi bron bosqichi: pending (Yangi) → deposit (zakalat kutilmoqda) →
     * confirmed (tasdiqlangan) → completed (yakunlangan). Bekor qilingani arxivga o'tadi.
     * `status` bilan sinxron: pending ↔ tentative, qolganlari ↔ booked.
     */
    stage: { type: String, enum: ['pending', 'deposit', 'confirmed', 'completed'] },
    menu_id: { type: String, default: '' },
    menu_name: { type: String, default: '' },
    /** Seans shabloni vaqtidan farq qilsa (masalan maxsus tadbir): HH:mm */
    start_time: { type: String, default: '' },
    end_time: { type: String, default: '' },
    address: { type: String, default: '' },
    /** Biriktirilgan ishchilar (Employee._id) */
    staff_ids: [{ type: Schema.Types.ObjectId }],
    event_type: { type: String, enum: EVENT_TYPES },
    customer_name: { type: String, default: '', trim: true },
    customer_phone: { type: String, default: '', trim: true },
    guests: { type: Number, default: 0, min: 0 },
    /** per_guest — mehmon × narx; fixed — aniq narx; negotiable — kelishilgan summa (total_price) */
    pricing_mode: { type: String, enum: PRICING_MODES, default: 'per_guest' },
    price_per_guest: { type: Number, default: 0, min: 0 },
    total_price: { type: Number, default: 0, min: 0 },
    /** To'lovlar: avans, qolgani — naqd / karta / hisob raqamiga (perechisleniye) */
    payments: [
      new Schema(
        {
          amount: { type: Number, required: true, min: 1 },
          method: { type: String, enum: PAY_METHODS, default: 'cash' },
          kind: { type: String, enum: ['deposit', 'payment', 'refund'], default: 'deposit' },
          date: { type: String, required: true },
          note: { type: String, default: '' },
          /** To'lov qabul qilingan aniq vaqt (ilovada "09:20" ko'rsatiladi) */
          at: { type: Date, default: () => new Date() },
        },
        { _id: true, timestamps: false },
      ),
    ],
    description: { type: String, default: '' },
};
const reservationSchema = new Schema(reservationFields, { timestamps: true });
reservationSchema.index({ hall_id: 1, date: 1, session: 1 }, { unique: true });
reservationSchema.index({ venue_id: 1, date: 1 });
reservationSchema.index({ venue_id: 1, 'payments.date': 1 });
export const ReservationModel = model('Reservation', reservationSchema);

/*
 * Bekor qilingan egasi bronlari (tarix, mijozlar ro'yxati, hisobotlar uchun).
 * Asosiy kolleksiyadagi (hall, date, session) unique indeks bir seansga ikkinchi yozuvni
 * yo'l qo'ymaydi, shuning uchun bekor qilinganda yozuv shu yerga ko'chadi va seans bo'shaydi.
 */
const cancelledReservationSchema = new Schema(
  {
    ...reservationFields,
    cancelled_at: { type: Date, default: () => new Date() },
    cancel_reason: { type: String, default: '' },
  },
  { timestamps: true },
);
cancelledReservationSchema.index({ venue_id: 1, date: -1 });
export const CancelledReservationModel = model('CancelledReservation', cancelledReservationSchema);

/** Kirim-chiqim (to'lovlardan tashqari): xarajatlar, soliq, kredit, ish haqi, boshqa kirim */
export const INCOME_CATEGORIES = ['bron', 'xizmat', 'ijara', 'boshqa_kirim'] as const;
export const EXPENSE_CATEGORIES = [
  'ish_haqi', 'oziq_ovqat', 'kommunal', 'soliq', 'kredit', 'ijara_tolov', 'tamir', 'jihoz', 'reklama', 'transport', 'boshqa',
] as const;
const transactionSchema = new Schema(
  {
    venue_id: { type: Schema.Types.ObjectId, ref: 'Venue', required: true, index: true },
    type: { type: String, enum: ['income', 'expense'], required: true },
    category: { type: String, required: true },
    amount: { type: Number, required: true, min: 1 },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    method: { type: String, enum: PAY_METHODS, default: 'cash' },
    note: { type: String, default: '' },
    employee_id: { type: Schema.Types.ObjectId, ref: 'Employee' },
    employee_name: { type: String },
  },
  { timestamps: true },
);
transactionSchema.index({ venue_id: 1, date: -1 });
export const TransactionModel = model('Transaction', transactionSchema);

/** Ishchilar: kunlik / oylik / tadbir boshiga haq */
const employeeSchema = new Schema(
  {
    venue_id: { type: Schema.Types.ObjectId, ref: 'Venue', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '' },
    position: { type: String, default: '' },
    pay_type: { type: String, enum: ['daily', 'monthly', 'per_event'], default: 'monthly' },
    rate: { type: Number, default: 0, min: 0 },
    hired_at: { type: String, default: '' },
    note: { type: String, default: '' },
    active: { type: Boolean, default: true },
    /* Mobil ilovaga kirish (rol: xodim). Kirish telefoni E.164; parol — scrypt hash. */
    app_access: { type: Boolean, default: false },
    app_phone: { type: String, default: '', index: true },
    password_hash: { type: String, default: '' },
    token_version: { type: Number, default: 0 },
    last_login_at: { type: Date },
  },
  { timestamps: true },
);
export const EmployeeModel = model('Employee', employeeSchema);

export type Reservation = InferSchemaType<typeof reservationSchema>;
