import { Types } from 'mongoose';
import { findVenue, vendorsFor } from '../venues/venue.service.js';
import { isWeekendISO, todayISO, addDaysISO, type SessionCode } from '../../lib/dates.js';
import { depositFor, pricePerGuest } from '../../lib/pricing.js';
import { badRequest } from '../../lib/http-error.js';

export interface QuoteInput {
  venue_id: string;
  hall_id: string;
  date: string;
  session: SessionCode;
  guests: number;
  menu_package_id: string;
  vendor_ids: string[];
}

export const MAX_DAYS_AHEAD = 400;

/** Barcha qiymatlar serverda qayta hisoblanadi — mijoz yuborgan narxga ishonilmaydi */
export async function buildQuote(input: QuoteInput) {
  const venue = await findVenue(input.venue_id);
  const hall = venue.halls.find((h) => String(h._id) === input.hall_id);
  if (!hall) throw badRequest('Zal topilmadi');
  const session = venue.sessions.find((s) => s.code === input.session);
  if (!session) throw badRequest('Bu to‘yxonada bunday seans yo‘q');
  const menu = venue.menu_packages.find((m) => String(m._id) === input.menu_package_id);
  if (!menu) throw badRequest('Menyu paketi topilmadi');

  const today = todayISO();
  if (input.date < today) throw badRequest('O‘tgan sanani tanlab bo‘lmaydi');
  if (input.date > addDaysISO(today, MAX_DAYS_AHEAD)) throw badRequest('Bu sana uchun hali bron ochilmagan');

  // Minimal mehmon soni seansga bog'liq (nahorgi osh 200, to'y 150), maksimal — zal sig'imi
  const minGuests = Math.max(1, session.min_guests || venue.guests_min);
  if (input.guests < minGuests || input.guests > hall.capacity_max) {
    throw badRequest(`Mehmonlar soni ${minGuests} – ${hall.capacity_max} oralig‘ida bo‘lishi kerak`, { min: minGuests, max: hall.capacity_max });
  }

  const vendorIds = [...new Set(input.vendor_ids)];
  const available = await vendorsFor(venue._id);
  const vendors = vendorIds.map((id) => {
    const v = available.find((x) => x.id === id);
    if (!v) throw badRequest('Tanlangan xizmat bu to‘yxonada mavjud emas', { vendor_id: id });
    return v;
  });
  const types = vendors.map((v) => v.type);
  if (new Set(types).size !== types.length) throw badRequest('Har bir xizmat turidan bittadan tanlash mumkin');

  const ppg = pricePerGuest(menu, session, isWeekendISO(input.date), venue.weekend_factor);
  const venue_total = ppg * input.guests;
  const extras = vendors.map((v) => ({ vendor_id: v.id, name: v.name, type: v.type, price: v.price }));
  const total = venue_total + extras.reduce((s, e) => s + e.price, 0);

  return {
    quote: { price_per_guest: ppg, venue_total, extras, total, deposit: depositFor(total, venue.deposit_percent) },
    venue,
    hall: hall as typeof hall & { _id: Types.ObjectId },
    session,
    menu: menu as typeof menu & { _id: Types.ObjectId },
  };
}
