import { connectDatabase, disconnectDatabase } from '../infrastructure/mongo.js';
import { VenueModel } from '../modules/venues/venue.model.js';
import { VendorModel } from '../modules/vendors/vendor.model.js';
import { SlotModel } from '../modules/slots/slot.model.js';
import { BookingModel } from '../modules/bookings/booking.model.js';
import { CancelledReservationModel, EmployeeModel, ReservationModel, TransactionModel, VenueAccountModel } from '../modules/owner/owner.models.js';
import { DishModel, PasswordResetModel, VenueApplicationModel } from '../modules/owner-app/owner-app.models.js';
import { hashPassword } from '../modules/owner/password.js';
import { addDaysISO, todayISO } from '../lib/dates.js';
import { VENUES, VENDORS } from './seed-data.js';

/** Demo hisoblar (ilovaga kirish): production'da faqat SEED_DEMO_ACCOUNTS=true bo'lsa */
export const DEMO = {
  owner: { phone: '+998901234567', password: 'owner123', login: 'navroz', name: 'Azimjon' },
  staff: { phone: '+998909999999', password: 'staff123', name: 'Rustam Karimov' },
};

async function seedOwnerDemo() {
  const venue = await VenueModel.findOne({ slug: 'navroz-saroyi' });
  if (!venue) return;
  await VenueAccountModel.updateOne(
    { venue_id: venue._id },
    { $setOnInsert: { venue_id: venue._id, login: DEMO.owner.login, password_hash: await hashPassword(DEMO.owner.password), phone: DEMO.owner.phone, name: DEMO.owner.name, active: true } },
    { upsert: true },
  );
  const staff = [
    { name: DEMO.staff.name, phone: DEMO.staff.phone, position: 'Administrator', pay_type: 'monthly' as const, rate: 4_000_000, app: true },
    { name: 'Dilnoza Aliyeva', phone: '+998935554433', position: 'Oshpaz', pay_type: 'monthly' as const, rate: 5_000_000, app: false },
    { name: 'Jasur Toshmatov', phone: '+998977778899', position: 'Ofitsiantlar boshlig‘i', pay_type: 'per_event' as const, rate: 300_000, app: false },
  ];
  for (const e of staff) {
    await EmployeeModel.updateOne(
      { venue_id: venue._id, name: e.name },
      { $setOnInsert: { venue_id: venue._id, name: e.name, phone: e.phone, position: e.position, pay_type: e.pay_type, rate: e.rate, active: true, ...(e.app ? { app_access: true, app_phone: e.phone, password_hash: await hashPassword(DEMO.staff.password) } : {}) } },
      { upsert: true },
    );
  }
  // Menyu paketlari uchun taomlar katalogi (rasmlarni egasi keyin Cloudinary'ga yuklaydi)
  const MENU_DISHES: Record<string, string[]> = {
    Standart: ['Palov', 'Norin', 'Salatlar (4 xil)', 'Mevalar', 'Choy, non'],
    Premium: ['Palov', 'Qazi', 'Shashlik', 'Salatlar (6 xil)', 'Shirinliklar', 'Ichimliklar', 'Tort'],
    VIP: ['Palov', 'Qo‘y go‘shti (butun)', 'Baliq', 'Kabob assorti', 'Salatlar (10 xil)', 'Tort', 'Mevalar'],
  };
  const fresh = await VenueModel.findById(venue._id);
  if (fresh) {
    let changed = false;
    for (const m of fresh.menu_packages) {
      const names = MENU_DISHES[m.name];
      if (m.dishes?.length || !names) continue;
      const ids = [];
      for (const n of names) {
        const key = n.replace(/\s+/g, ' ').toLowerCase();
        const d = await DishModel.findOneAndUpdate({ venue_id: venue._id, name_key: key }, { $setOnInsert: { name: n, name_key: key } }, { upsert: true, returnDocument: 'after' }).lean();
        ids.push(d!._id);
      }
      m.dishes = ids as never; m.items_text = names.join(', '); changed = true;
    }
    if (changed) await fresh.save();
  }
  // Namuna bron: kelgusi sana, avans to'langan
  const hall = venue.halls[0];
  const date = addDaysISO(todayISO(), 5);
  if (hall && !(await ReservationModel.exists({ venue_id: venue._id, date, session: 'evening' }))) {
    const r = await ReservationModel.create({
      venue_id: venue._id, hall_id: hall._id, hall_name: hall.name, date, session: 'evening', status: 'booked', stage: 'confirmed',
      event_type: 'kechki', customer_name: 'Azizbek & Dilshoda', customer_phone: '+998901112233', guests: 300, pricing_mode: 'per_guest',
      price_per_guest: 190_000, total_price: 57_000_000,
      payments: [{ amount: 10_000_000, kind: 'deposit', method: 'cash', date: todayISO(), note: '' }],
    });
    await SlotModel.updateOne({ hall_id: hall._id, date, session: 'evening' }, { $set: { venue_id: venue._id, status: 'booked', reservation_id: r._id, note: 'Azizbek & Dilshoda' } }, { upsert: true });
  }
}

export async function seed({ fresh = false, demoAccounts = process.env.NODE_ENV !== 'production' || process.env.SEED_DEMO_ACCOUNTS === 'true' } = {}) {
  if (fresh) {
    await Promise.all([
      VenueModel.deleteMany({}), VendorModel.deleteMany({}), SlotModel.deleteMany({}), BookingModel.deleteMany({}),
      VenueAccountModel.deleteMany({}), EmployeeModel.deleteMany({}), ReservationModel.deleteMany({}), CancelledReservationModel.deleteMany({}),
      TransactionModel.deleteMany({}), DishModel.deleteMany({}), PasswordResetModel.deleteMany({}), VenueApplicationModel.deleteMany({}),
    ]);
  }
  for (const v of VENUES) {
    await VenueModel.updateOne({ slug: v.slug }, { $setOnInsert: v }, { upsert: true });
  }
  for (const x of VENDORS) {
    await VendorModel.updateOne({ type: x.type, name: x.name }, { $setOnInsert: { ...x, venue_ids: [] } }, { upsert: true });
  }
  if (demoAccounts) await seedOwnerDemo();
  return { venues: await VenueModel.countDocuments(), vendors: await VendorModel.countDocuments() };
}

// To'g'ridan-to'g'ri ishga tushirilganda
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    await connectDatabase();
    await VenueModel.syncIndexes();
    await SlotModel.syncIndexes();
    await ReservationModel.syncIndexes();
    await DishModel.syncIndexes();
    const r = await seed({ fresh: process.argv.includes('--fresh') });
    console.log('Seed tayyor:', r);
    await disconnectDatabase();
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
