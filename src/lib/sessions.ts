/*
 * ═══ SEANSLAR VA TADBIR TURLARI — YAGONA MANBA ═══
 *
 * To'yxona kuni 3 asosiy seans + 1 maxsus:
 *   morning — Nahorgi osh
 *   day     — Nikoh to'yi (kunduzi)
 *   evening — Kunduzgi/Vecher (kechki to'y)
 *   special — Plandan tashqari tadbir: konsert, shou, majlis...
 *             Narxi odatda KELISHILADI (pricing_mode: 'negotiable') —
 *             onlayn bron qilinmaydi, to'yxona egasi qo'lda band qiladi.
 *
 * `code` qiymatlari bazada (slots, bookings) saqlanadi — O'ZGARTIRILMAYDI.
 * Ilova eski 3 seansni ko'rsatishda davom etadi; 'special' qo'shimcha.
 */
export const SESSION_CODES = ['morning', 'day', 'evening', 'special'] as const;
export type SessionCodeAll = (typeof SESSION_CODES)[number];

export const SESSION_LABELS: Record<SessionCodeAll, string> = {
  morning: 'Nahorgi osh',
  day: "Nikoh to'yi",
  evening: 'Kunduzgi / Vecher',
  special: 'Maxsus tadbir',
};

export const EVENT_TYPES = ['nahorgi_osh', 'nikoh', 'kunduzgi', 'kechki', 'tadbir'] as const;
export type EventTypeAll = (typeof EVENT_TYPES)[number];

/*
 * Narx qanday hisoblanadi:
 *   per_guest  — menyu narxi × mehmonlar × seans koeffitsienti (× dam olish kuni)
 *   fixed      — seans uchun aniq narx (mehmon soniga bog'liq emas) + menyu shart emas
 *   negotiable — narx kelishiladi; onlayn bron yo'q, faqat egasi band qiladi
 */
export const PRICING_MODES = ['per_guest', 'fixed', 'negotiable'] as const;
export type PricingMode = (typeof PRICING_MODES)[number];
