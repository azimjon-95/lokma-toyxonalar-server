// Demo ma'lumotlar — mobil ilovadagi src/data/mockData.ts bilan bir xil.
const u = (id: string) => `https://images.unsplash.com/${id}?w=1200&q=70&auto=format&fit=crop`;
const PHOTOS = [
  u('photo-1519167758481-83f29da849d1'), u('photo-1464366400600-7168b8af9bc3'), u('photo-1478144592103-25e218a04891'),
  u('photo-1519225421980-715cb0215aed'), u('photo-1511795409834-ef04bbd61622'), u('photo-1505236858219-8359eb29e329'),
];
const photoSet = (offset: number) => Array.from({ length: 12 }, (_, i) => PHOTOS[(i + offset) % PHOTOS.length]);

const AMENITIES = ['Konditsioner', 'Sahna va LED ekran', 'Ovoz tizimi', 'Kelin xonasi', 'Namozxona', 'Bolalar xonasi', 'Generator', 'Wi-Fi'];

export const SESSIONS = [
  { code: 'morning', start_time: '06:00', end_time: '10:00', event_types: ['nahorgi_osh'], price_factor: 0.6, min_guests: 200 },
  { code: 'day', start_time: '12:00', end_time: '16:00', event_types: ['kunduzgi', 'nikoh'], price_factor: 1, min_guests: 150 },
  { code: 'evening', start_time: '18:00', end_time: '23:00', event_types: ['kechki', 'nikoh'], price_factor: 1.15, min_guests: 150 },
] as const;

const r10k = (n: number) => Math.round(n / 10000) * 10000;
const menu = (base: number) => [
  { name: 'Standart', price_per_guest: base, items_text: 'Osh, 4 xil salat, 2 issiq taom, meva, shirinlik, choy' },
  { name: 'Premium', price_per_guest: r10k(base * 1.45), items_text: 'Standart + qazi, 6 xil salat, 3 issiq taom, tort' },
  { name: 'VIP', price_per_guest: r10k(base * 2.1), items_text: 'Premium + baliq, shashlik, alohida ofitsiantlar' },
];
const halls = (big: number, small?: number) => [
  { name: 'Katta zal', capacity_min: Math.round(big * 0.4), capacity_max: big },
  ...(small ? [{ name: 'Kichik zal', capacity_min: 100, capacity_max: small }] : []),
];

const v = (
  slug: string, name: string, district: string, address: string, lat: number, lng: number,
  rating: number, reviews: number, parking: number, amenities: string[], h: ReturnType<typeof halls>, base: number, photoOffset: number,
) => ({
  slug, name, district, address, lat, lng, rating, reviews_count: reviews, parking_spots: parking, amenities,
  halls: h, menu_packages: menu(base), photos: photoSet(photoOffset), sessions: SESSIONS.map((s) => ({ ...s, event_types: [...s.event_types] })),
  phone: '+998712000000', description: `${name} — ${district} tumanidagi zamonaviy to‘yxona.`,
  weekend_factor: 1.15, deposit_percent: 30, guests_min: 150, status: 'active' as const,
});

export const VENUES = [
  v('navroz-saroyi', 'Navro‘z Saroyi', 'Chilonzor', 'Chilonzor tumani, Bunyodkor ko‘chasi', 41.2856, 69.2034, 4.8, 312, 150, AMENITIES, halls(900, 400), 150000, 0),
  v('oltin-qasr', 'Oltin Qasr', 'Yakkasaroy', 'Yakkasaroy tumani, Shota Rustaveli ko‘chasi', 41.2995, 69.2401, 4.7, 198, 80, AMENITIES.slice(0, 5), halls(600), 180000, 3),
  v('bahor-koshk', 'Bahor Ko‘shk', 'Uchtepa', 'Uchtepa tumani, Lutfiy ko‘chasi', 41.2921, 69.1748, 4.6, 145, 0, ['Konditsioner', 'Sahna va LED ekran', 'Kelin xonasi', 'Generator'], halls(500), 110000, 1),
  v('gulshan-hall', 'Gulshan Hall', 'Sergeli', 'Sergeli tumani, Yangi Sergeli ko‘chasi', 41.2271, 69.2208, 4.9, 421, 200, AMENITIES, halls(800, 300), 130000, 2),
  v('afsona-saroyi', 'Afsona Saroyi', 'Yunusobod', 'Yunusobod tumani, Amir Temur ko‘chasi', 41.3655, 69.2869, 4.8, 276, 180, AMENITIES, halls(1000, 450), 190000, 4),
  v('iqbol-toyxonasi', 'Iqbol To‘yxonasi', 'Zangiota', 'Zangiota tumani, Toshkent halqa yo‘li', 41.2489, 69.1203, 4.5, 88, 120, AMENITIES.slice(0, 6), halls(700), 100000, 5),
  v('yulduz-palace', 'Yulduz Palace', 'Qibray', 'Qibray tumani', 41.3912, 69.4471, 4.7, 164, 250, AMENITIES, halls(1200, 500), 160000, 2),
  v('chinor-bog', 'Chinor Bog‘', 'Chirchiq', 'Chirchiq shahri, Amir Temur ko‘chasi', 41.4689, 69.5822, 4.6, 59, 90, AMENITIES.slice(0, 4), halls(600), 90000, 0),
];

export const VENDORS = [
  { type: 'video', name: 'Kadr Studio', description: '2 kamera · montaj · 4K', price: 5_000_000, rating: 4.8 },
  { type: 'video', name: 'Lens Media', description: '3 kamera · dron · klip', price: 8_500_000, rating: 4.9 },
  { type: 'video', name: 'Oila Film', description: '1 kamera · montaj', price: 3_000_000, rating: 4.6 },
  { type: 'video', name: 'Premium Wedding', description: '4 kamera · dron · Love story', price: 12_000_000, rating: 5.0 },
  { type: 'cortege', name: 'Chevrolet Malibu', description: '5 ta oq mashina · 3 soat', price: 2_500_000 },
  { type: 'cortege', name: 'Lincoln limuzin', description: '1 ta · 4 soat', price: 3_500_000 },
  { type: 'cortege', name: 'Mercedes E-class', description: '3 ta · gul bezagi bilan', price: 4_500_000 },
  { type: 'cortege', name: 'Retro Volga', description: '2 ta · fotosessiya uchun', price: 2_000_000 },
] as const;
