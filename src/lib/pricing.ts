// Narx formulasi — mobil ilovadagi src/services/pricing.ts bilan bir xil bo'lishi SHART.
export interface PricedMenu { price_per_guest: number }
export interface PricedSession { price_factor: number; pricing_mode?: string | null }

export const roundTo1000 = (n: number) => Math.round(n / 1000) * 1000;

export function pricePerGuest(menu: PricedMenu, session: PricedSession, weekend: boolean, weekendFactor: number) {
  return roundTo1000(menu.price_per_guest * session.price_factor * (weekend ? weekendFactor : 1));
}

export function priceRange(menus: PricedMenu[], sessions: PricedSession[], weekendFactor: number) {
  // Faqat mehmon boshiga hisoblanadigan seanslar (aniq/kelishiladigan narx oraliqqa kirmaydi)
  sessions = sessions.filter((s) => !s.pricing_mode || s.pricing_mode === 'per_guest');
  if (!menus.length || !sessions.length) return { from: 0, to: 0 };
  const prices = menus.map((m) => m.price_per_guest);
  const factors = sessions.map((s) => s.price_factor);
  return {
    from: roundTo1000(Math.min(...prices) * Math.min(...factors)),
    to: roundTo1000(Math.max(...prices) * Math.max(...factors) * weekendFactor),
  };
}

export const depositFor = (total: number, percent: number) => Math.round((total * percent) / 100);
