import { SESSION_CODES, EVENT_TYPES, PRICING_MODES } from '../../lib/sessions.js';
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const hallSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    capacity_min: { type: Number, required: true, min: 1 },
    capacity_max: { type: Number, required: true, min: 1 },
  },
  { _id: true },
);

const sessionSchema = new Schema(
  {
    code: { type: String, enum: SESSION_CODES, required: true },
    start_time: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
    end_time: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
    event_types: [{ type: String, enum: EVENT_TYPES }],
    price_factor: { type: Number, required: true, min: 0.1, max: 5 },
    min_guests: { type: Number, default: 100, min: 1 },
    /** Narx turi (lib/sessions.ts): per_guest | fixed | negotiable */
    pricing_mode: { type: String, enum: PRICING_MODES, default: 'per_guest' },
    /** pricing_mode='fixed' — seansning aniq narxi (so'm) */
    fixed_price: { type: Number, default: 0, min: 0 },
    /** Ilovada ko'rinadigan qisqa izoh: "Konsert, shou, majlislar — narx kelishiladi" */
    note: { type: String, default: '' },
  },
  { _id: false },
);

const menuSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    items_text: { type: String, default: '' },
    price_per_guest: { type: Number, required: true, min: 0 },
  },
  { _id: true },
);

const venueSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9-]+$/ },
    name: { type: String, required: true, trim: true },
    district: { type: String, required: true, trim: true },
    address: { type: String, default: '' },
    phone: { type: String, default: '' },
    description: { type: String, default: '' },
    lat: { type: Number, required: true, min: -90, max: 90 },
    lng: { type: Number, required: true, min: -180, max: 180 },
    rating: { type: Number, default: 0, min: 0, max: 5 },
    reviews_count: { type: Number, default: 0, min: 0 },
    photos: [{ type: String }],
    parking_spots: { type: Number, default: 0, min: 0 },
    amenities: [{ type: String }],
    halls: { type: [hallSchema], validate: [(v: unknown[]) => v.length > 0, 'Kamida bitta zal kerak'] },
    sessions: { type: [sessionSchema], validate: [(v: unknown[]) => v.length > 0, 'Kamida bitta seans kerak'] },
    menu_packages: { type: [menuSchema], validate: [(v: unknown[]) => v.length > 0, 'Kamida bitta menyu kerak'] },
    weekend_factor: { type: Number, default: 1.15, min: 1, max: 3 },
    deposit_percent: { type: Number, default: 30, min: 0, max: 100 },
    guests_min: { type: Number, default: 150, min: 1 },
    /*
     * active  — mijozlarga ko'rinadi
     * hidden  — vaqtincha yashirin (egasi so'radi, tayyor emas)
     * blocked — admin bloklagan (to'lov qilinmagan, qoidabuzarlik) — sababi block_reason
     * Ommaviy API faqat 'active' ni beradi (venue.service.ts).
     */
    status: { type: String, enum: ['active', 'hidden', 'blocked'], default: 'active', index: true },
    block_reason: { type: String, default: '' },
    blocked_at: { type: Date, default: null },

    /* Egasi / mas'ul shaxs — admin uchun (mijozga ko'rsatilmaydi) */
    owner: {
      name: { type: String, default: '' },
      phone: { type: String, default: '' },
      telegram: { type: String, default: '' },
      note: { type: String, default: '' },
    },

    /*
     * OYLIK TO'LOV (platformaga obuna).
     *   monthly_fee — oyiga necha so'm
     *   paid_until  — to'langan oxirgi kun (YYYY-MM-DD, Toshkent). To'lovlar
     *                 (payment.model.ts) asosida avtomatik qayta hisoblanadi.
     *   billing_start — hisob qaysi oydan boshlanadi (YYYY-MM)
     */
    subscription: {
      monthly_fee: { type: Number, default: 0, min: 0 },
      paid_until: { type: String, default: '' },
      billing_start: { type: String, default: '' },
    },
  },
  { timestamps: true },
);

venueSchema.index({ lat: 1, lng: 1 });

export type Venue = InferSchemaType<typeof venueSchema>;
export type VenueDoc = HydratedDocument<Venue>;
export const VenueModel = model('Venue', venueSchema);
