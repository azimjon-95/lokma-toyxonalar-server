import { SESSION_CODES, EVENT_TYPES } from '../../lib/sessions.js';
import { Schema, model, type InferSchemaType } from 'mongoose';

const bookingSchema = new Schema(
  {
    number: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'confirmed', 'cancelled', 'completed'], default: 'pending', index: true },
    cancel_reason: { type: String },
    user_id: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    customer_name: { type: String, required: true, trim: true },
    customer_phone: { type: String, required: true },
    venue_id: { type: Schema.Types.ObjectId, ref: 'Venue', required: true, index: true },
    venue_name: { type: String, required: true },
    hall_id: { type: Schema.Types.ObjectId, required: true },
    hall_name: { type: String, required: true },
    date: { type: String, required: true },
    session: { type: String, enum: SESSION_CODES, required: true },
    event_type: { type: String, enum: EVENT_TYPES, required: true },
    guests: { type: Number, required: true, min: 1 },
    menu: { id: String, name: String, price_per_guest: Number },
    extras: [{ vendor_id: String, name: String, type: { type: String }, price: Number, _id: false }],
    price_per_guest: { type: Number, required: true },
    venue_total: { type: Number, required: true },
    total: { type: Number, required: true },
    deposit: { type: Number, required: true },
    payment_url: { type: String, default: null },
    paid_at: { type: Date },
    hold_until: { type: Date, required: true },
    /* To'yxona egasi ilovasidan kiritiladi: qabul qilingan to'lovlar, ishchilar, izoh */
    payments: [
      new Schema(
        {
          amount: { type: Number, required: true, min: 1 },
          method: { type: String, enum: ['cash', 'card', 'transfer', 'click', 'payme', 'other'], default: 'cash' },
          kind: { type: String, enum: ['deposit', 'payment', 'refund'], default: 'deposit' },
          date: { type: String, required: true },
          note: { type: String, default: '' },
          at: { type: Date, default: () => new Date() },
        },
        { _id: true, timestamps: false },
      ),
    ],
    staff_ids: [{ type: Schema.Types.ObjectId }],
    notes: { type: String, default: '' },
  },
  { timestamps: true },
);

export type Booking = InferSchemaType<typeof bookingSchema>;
export const BookingModel = model('Booking', bookingSchema);
