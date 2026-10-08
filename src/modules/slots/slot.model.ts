import { SESSION_CODES, EVENT_TYPES } from '../../lib/sessions.js';
import { Schema, model, type InferSchemaType } from 'mongoose';

// Faqat bo'sh BO'LMAGAN seanslar saqlanadi. Yozuv yo'q = bo'sh.
// (hall_id, date, session) unique — bir seansni ikki kishi band qila olmaydi.
const slotSchema = new Schema(
  {
    venue_id: { type: Schema.Types.ObjectId, ref: 'Venue', required: true, index: true },
    hall_id: { type: Schema.Types.ObjectId, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    session: { type: String, enum: SESSION_CODES, required: true },
    status: { type: String, enum: ['hold', 'booked', 'closed'], required: true },
    hold_until: { type: Date },
    booking_id: { type: Schema.Types.ObjectId, ref: 'Booking' },
    /** To'yxona egasi kalendarda qo'lda band qilgan bo'lsa (owner/Reservation) */
    reservation_id: { type: Schema.Types.ObjectId, ref: 'Reservation' },
    note: { type: String },
  },
  { timestamps: true },
);

slotSchema.index({ hall_id: 1, date: 1, session: 1 }, { unique: true });
slotSchema.index({ status: 1, hold_until: 1 });

export type Slot = InferSchemaType<typeof slotSchema>;
export const SlotModel = model('Slot', slotSchema);
