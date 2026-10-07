import { Schema, model, type InferSchemaType } from 'mongoose';

const vendorSchema = new Schema(
  {
    type: { type: String, enum: ['video', 'cortege'], required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    price: { type: Number, required: true, min: 0 },
    photo: { type: String },
    rating: { type: Number, min: 0, max: 5 },
    /** Bo'sh = barcha to'yxonalarda taklif qilinadi */
    venue_ids: [{ type: Schema.Types.ObjectId, ref: 'Venue' }],
    active: { type: Boolean, default: true },

    /* ── Admin uchun to'liq ma'lumot ── */
    contact_name: { type: String, default: '' },
    phone: { type: String, default: '' },
    telegram: { type: String, default: '' },
    district: { type: String, default: '' },
    experience_years: { type: Number, default: 0, min: 0 },
    /** Portfolio rasmlari va video havolalari (YouTube, Instagram, Telegram) */
    photos: [{ type: String }],
    portfolio_urls: [{ type: String }],
    note: { type: String, default: '' },

    /** Videochi/kamerachi: jihozlar, xizmat tarkibi */
    video: {
      cameras: { type: Number, default: 1, min: 0 },
      has_drone: { type: Boolean, default: false },
      equipment: { type: String, default: '' },
      delivery_days: { type: Number, default: 0, min: 0 },
      services: [{ type: String }], // 'video', 'foto', 'klip', 'love_story', 'jonli_efir'
    },

    /** Kortej: mashinalar ro'yxati */
    cars: [
      new Schema(
        {
          model: { type: String, required: true, trim: true },
          color: { type: String, default: '' },
          year: { type: Number },
          count: { type: Number, default: 1, min: 1 },
          price: { type: Number, default: 0, min: 0 },
        },
        { _id: true },
      ),
    ],

    /** Admin bloklagan bo'lsa — sababi (blocked=true bo'lsa active=false) */
    blocked: { type: Boolean, default: false, index: true },
    block_reason: { type: String, default: '' },
  },
  { timestamps: true },
);

export type Vendor = InferSchemaType<typeof vendorSchema>;
export const VendorModel = model('Vendor', vendorSchema);
