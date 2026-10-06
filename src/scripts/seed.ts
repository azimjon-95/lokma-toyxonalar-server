import { connectDatabase, disconnectDatabase } from '../infrastructure/mongo.js';
import { VenueModel } from '../modules/venues/venue.model.js';
import { VendorModel } from '../modules/vendors/vendor.model.js';
import { SlotModel } from '../modules/slots/slot.model.js';
import { BookingModel } from '../modules/bookings/booking.model.js';
import { VENUES, VENDORS } from './seed-data.js';

export async function seed({ fresh = false } = {}) {
  if (fresh) {
    await Promise.all([VenueModel.deleteMany({}), VendorModel.deleteMany({}), SlotModel.deleteMany({}), BookingModel.deleteMany({})]);
  }
  for (const v of VENUES) {
    await VenueModel.updateOne({ slug: v.slug }, { $setOnInsert: v }, { upsert: true });
  }
  for (const x of VENDORS) {
    await VendorModel.updateOne({ type: x.type, name: x.name }, { $setOnInsert: { ...x, venue_ids: [] } }, { upsert: true });
  }
  return { venues: await VenueModel.countDocuments(), vendors: await VendorModel.countDocuments() };
}

// To'g'ridan-to'g'ri ishga tushirilganda
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    await connectDatabase();
    await VenueModel.syncIndexes();
    await SlotModel.syncIndexes();
    const r = await seed({ fresh: process.argv.includes('--fresh') });
    console.log('Seed tayyor:', r);
    await disconnectDatabase();
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
