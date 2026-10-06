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
  },
  { timestamps: true },
);

export type Vendor = InferSchemaType<typeof vendorSchema>;
export const VendorModel = model('Vendor', vendorSchema);
