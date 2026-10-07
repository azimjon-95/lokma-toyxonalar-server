import { Schema, model, type InferSchemaType } from 'mongoose';

/*
 * To'yxonaning platformaga OYLIK TO'LOVI (obuna).
 * Bitta yozuv — bir yoki bir necha oy uchun to'lov: period_from (YYYY-MM)
 * dan boshlab `months` oy. Venue.subscription.paid_until shu yozuvlardan
 * qayta hisoblanadi (payment.service.ts → recalcPaidUntil).
 */
const paymentSchema = new Schema(
  {
    venue_id: { type: Schema.Types.ObjectId, ref: 'Venue', required: true, index: true },
    venue_name: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    period_from: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    months: { type: Number, required: true, min: 1, max: 24 },
    method: { type: String, enum: ['cash', 'card', 'transfer', 'click', 'payme', 'other'], default: 'cash' },
    paid_at: { type: Date, default: () => new Date() },
    note: { type: String, default: '' },
    created_by: { type: String, default: '' },
  },
  { timestamps: true },
);
paymentSchema.index({ venue_id: 1, period_from: -1 });

export type Payment = InferSchemaType<typeof paymentSchema>;
export const PaymentModel = model('Payment', paymentSchema);
