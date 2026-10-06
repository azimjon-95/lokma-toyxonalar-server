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
    code: { type: String, enum: ['morning', 'day', 'evening'], required: true },
    start_time: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
    end_time: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
    event_types: [{ type: String, enum: ['nahorgi_osh', 'nikoh', 'kunduzgi', 'kechki'] }],
    price_factor: { type: Number, required: true, min: 0.1, max: 5 },
    min_guests: { type: Number, default: 100, min: 1 },
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
    status: { type: String, enum: ['active', 'hidden'], default: 'active', index: true },
  },
  { timestamps: true },
);

venueSchema.index({ lat: 1, lng: 1 });

export type Venue = InferSchemaType<typeof venueSchema>;
export type VenueDoc = HydratedDocument<Venue>;
export const VenueModel = model('Venue', venueSchema);
