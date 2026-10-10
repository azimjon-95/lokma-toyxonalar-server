# Lokma To'yxonalari — server (API)

Mobil ilova ([lokma-toyxonalar](https://github.com/azimjon-95/lokma-toyxonalar)) uchun backend:
atrofdagi to'yxonalar, bo'sh kunlar kalendari, narx hisobi, bron (30 daqiqalik hold), Telegram avtorizatsiya, admin API.

**Stack:** Node.js 22, TypeScript, Express 5, MongoDB (Mongoose 9), Zod 4, JWT. Docker.

## Ishga tushirish (lokal)

```bash
cp .env.example .env
docker compose up -d          # MongoDB
npm install
npm run seed                  # demo: 8 ta to'yxona, 8 ta videochi/kortej (ilovadagi bilan bir xil)
npm run dev                   # http://localhost:4100/api/health/ready
```

Mobil ilovada `.env`: `EXPO_PUBLIC_API_URL=http://<kompyuter-IP>:4100` (telefon bilan bir Wi-Fi'da).

| Buyruq | Vazifasi |
|---|---|
| `npm run dev` | qayta yuklanuvchi dev server |
| `npm run build && npm start` | production |
| `npm test` | integratsion testlar (MongoDB kerak, `TEST_MONGODB_URI`) |
| `npm run seed` / `seed:fresh` | demo ma'lumot (fresh — hammasini o'chirib qayta) |
| `npm run typecheck` | TypeScript |

## Production (Docker)

```bash
cp .env.example .env    # JWT_SECRET, ADMIN_API_KEY, MONGO_ROOT_USER/PASSWORD, CORS_ORIGINS ni to'ldiring
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
docker compose -f docker-compose.prod.yml exec api node dist/scripts/seed.js   # ixtiyoriy
```
API `127.0.0.1:4100` da ochiladi — tashqariga nginx (HTTPS) orqali chiqaring:
```nginx
location /api/ { proxy_pass http://127.0.0.1:4100; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header Host $host; }
```
Production'da `JWT_SECRET` va `ADMIN_API_KEY` (≥24 belgi) o'rnatilmasa server ishga tushmaydi.

## API

To'liq shartnoma: ilova reposidagi `docs/API.md`. Qisqacha:

| Metod | Yo'l | |
|---|---|---|
| GET | `/api/venues?lat&lng&radius_km&q&filter&event_type&sort` | atrofdagi to'yxonalar |
| GET | `/api/venues/free-soon?lat&lng&radius_km&days` | "3 kun ichida bo'sh" |
| GET | `/api/venues/:slug?lat&lng` | to'yxona sahifasi |
| GET | `/api/halls/:hallId/calendar?month=YYYY-MM` | 3 seans × oy |
| POST | `/api/quote` | narx hisobi |
| POST | `/api/bookings` | bron (201) · band bo'lsa 409 `slot_taken` |
| POST | `/api/auth/telegram` | `{init_data}` → `{token}` |
| GET | `/api/me/bookings` | mening bronlarim (Bearer) |
| POST | `/api/bookings/:id/cancel` | o'z bronini bekor qilish (Bearer) |
| GET | `/api/health/live`, `/api/health/ready` | monitoring |

**Admin** (`X-Admin-Key` sarlavhasi):
`GET/POST /api/admin/venues`, `PATCH /api/admin/venues/:id`,
`GET/POST /api/admin/vendors`, `PATCH /api/admin/vendors/:id`,
`PUT /api/admin/slots` (seansni yopish/ochish),
`GET /api/admin/bookings?status&date&venue_id`, `POST /api/admin/bookings/:id/confirm|cancel`.

**Admin — to'liq boshqaruv (LokmaGo admin paneli orqali ishlatiladi):**

| Metod | Yo'l | |
|---|---|---|
| GET | `/api/admin/stats` | boshqaruv raqamlari (to'yxonalar, obuna qarzi, bronlar, xizmatlar) |
| GET | `/api/admin/venues?status&q` · `/api/admin/venues/:id` | ro'yxat/bitta — `subscription_state` bilan |
| POST | `/api/admin/venues/:id/block` `{reason}` · `/unblock` | bloklash (mijozga ko'rinmaydi, bron qabul qilinmaydi) |
| GET | `/api/admin/subscriptions` | oylik to'lov nazorati (qarzdorlar birinchi) |
| GET/POST | `/api/admin/payments` · DELETE `/api/admin/payments/:id` | oylik to'lovlar; `paid_until` avtomatik qayta hisoblanadi |
| GET | `/api/admin/vendors?type=video\|cortege` · `/api/admin/vendors/:id` | videochi/kamerachi, kortej |
| POST | `/api/admin/vendors/:id/block` · `/unblock` · DELETE | bloklash; bronlarda ishlatilgan bo'lsa o'chirilmaydi (409) |
| GET | `/api/admin/bookings?status&from&to&q&venue_id` | bronlarni kuzatish |

LokmaGo admin paneli bu API'ga **to'g'ridan-to'g'ri emas**, lokmago-server orqali ulanadi
(`/api/admin/wedding/*` → shu server, `X-Admin-Key` brauzerga chiqmaydi).

**To'yxona egasi / xodim mobil ilovasi** ([lokma-toyxona-owner](https://github.com/azimjon-95/lokma-toyxona-owner)) —
alohida token bilan ishlaydigan `/api/owner-app` yuzasi: bronlar (egasi + Lokma), to'lovlar, mijozlar, moliya, menyu/taomlar,
xodimlar, **Cloudinary rasmlari**, parolni SMS bilan tiklash, yangi to'yxona arizasi. To'liq shartnoma: [`docs/OWNER_APP_API.md`](docs/OWNER_APP_API.md).
Xodim roli pulni ko'rmaydi — pul maydonlari serverdan umuman chiqmaydi.

## Muhim qoidalar

- **Bitta seans — bitta bron.** `slots` kolleksiyasida `(hall_id, date, session)` unique indeks:
  parallel so'rovlardan faqat bittasi o'tadi (testda 6 ta parallel so'rov bilan tekshirilgan).
- **Hold.** Bron `pending` holatda yaratiladi, seans `HOLD_MINUTES` (30) daqiqa ushlab turiladi.
  To'lov tasdiqlansa (`/admin/bookings/:id/confirm`, keyin to'lov webhook'i) → `booked`.
  Muddat o'tsa fon vazifasi bronni `cancelled (expired)` qiladi va seans bo'shaydi.
- **Narx serverda hisoblanadi**, mijoz yuborgan narxga ishonilmaydi. Formula: `src/lib/pricing.ts`
  (ilovadagi `src/services/pricing.ts` bilan bir xil).
- **Sana** Toshkent vaqti bo'yicha (`TZ_NAME`). Shanba–yakshanba +15% (`weekend_factor`).
- Masofa: bounding box bilan bazadan oldindan saralash + haversine.

## Tuzilma

```
src/
  index.ts, app.ts, jobs.ts        ishga tushirish, Express, fon vazifalari
  config/env.ts                    .env (Zod bilan tekshiriladi)
  infrastructure/                  MongoDB, logger
  lib/                             sana, geo, narx, xatolar, validatsiya
  modules/
    venues/    vendors/            to'yxonalar, videochi/kortej
    slots/                         kalendar, hold/booked, unique band qilish
    bookings/                      narx (quote), bron, bekor qilish, tasdiqlash
    auth/                          Telegram initData, JWT, admin kaliti
    admin/  health/
  scripts/seed.ts                  demo ma'lumot
test/api.test.ts, owner-app.test.ts   59 ta integratsion test
```

## Keyingi bosqich

- To'lov: Click / Payme / Uzum — `booking.service.ts` dagi `payment_url` va webhook → `confirmBooking`.
- Telegram bot orqali admin'ga yangi bron xabari.
- Sharhlar (faqat to'yi o'tgan bron egasi).
