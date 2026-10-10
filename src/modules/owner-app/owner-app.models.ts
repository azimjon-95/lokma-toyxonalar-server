import { Schema, model } from 'mongoose';

/** Egasi boshqaradigan taomlar katalogi (menyu paketlari shu taomlarga havola qiladi) */
const dishSchema = new Schema(
  {
    venue_id: { type: Schema.Types.ObjectId, ref: 'Venue', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    /** Nom bo'yicha takrorlanishni oldini olish: kichik harf, ortiqcha bo'shliqsiz */
    name_key: { type: String, required: true },
    photo: {
      type: new Schema(
        { public_id: String, version: Number, width: Number, height: Number, bytes: Number, format: String },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true },
);
dishSchema.index({ venue_id: 1, name_key: 1 }, { unique: true });
export const DishModel = model('Dish', dishSchema);

/** "Yangi to'yxona ochish" arizasi (ro'yxatdan o'tmagan foydalanuvchi yuboradi; admin ko'rib chiqadi) */
const applicationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    address: { type: String, required: true, trim: true, maxlength: 300 },
    phone: { type: String, required: true },
    halls: { type: Number, required: true, min: 1, max: 20 },
    capacity: { type: Number, required: true, min: 1, max: 20000 },
    services: [{ type: String, maxlength: 60 }],
    photos: [{ public_id: String, url: String }],
    price_from: { type: Number, min: 0 },
    price_to: { type: Number, min: 0 },
    notes: { type: String, default: '', maxlength: 2000 },
    status: { type: String, enum: ['new', 'contacted', 'approved', 'rejected'], default: 'new', index: true },
    admin_note: { type: String, default: '' },
    ip: { type: String, default: '' },
  },
  { timestamps: true },
);
export const VenueApplicationModel = model('VenueApplication', applicationSchema);

/** Parolni tiklash kodi (faqat hash saqlanadi). expires_at bo'yicha avtomatik tozalanadi (TTL). */
const resetSchema = new Schema(
  {
    phone: { type: String, required: true, index: true },
    code_hash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    last_sent_at: { type: Date, default: () => new Date() },
    expires_at: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true },
);
export const PasswordResetModel = model('PasswordReset', resetSchema);
