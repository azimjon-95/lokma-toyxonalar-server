# To'yxona egasi / xodim mobil ilovasi — API (`/api/owner-app`)

Ilova: [lokma-toyxona-owner](https://github.com/azimjon-95/lokma-toyxona-owner). Ilova `EXPO_PUBLIC_API_URL=https://api.lokma.uz`
ga ulanadi va barcha so'rovlarni `/api/owner-app/...` ga yuboradi. **`/api/owner` (LokmaGo admin paneli, `X-Admin-Key`) bilan
bir xil ma'lumot bazasi va seans mantig'i**, lekin kirish va javob shakli ilova uchun.

Xatolar: `{ "message": "...", "code": "..." }` — 401 (token yaroqsiz → ilova chiqib ketadi), 403 (rol yetmaydi / to'yxona
bloklangan), 409 (band seans, noto'g'ri holat), 422 (tekshiruv), 429 (urinishlar ko'p).

## Rollar

| | owner | staff |
|---|---|---|
| Bronlarni ko'rish, yangi bron yaratish, mijozlar, menyu/taomlarni ko'rish, xodimlar (ism, lavozim, telefon) | ✓ | ✓ |
| **Pul maydonlari** (`total`, `paid`, `balance`, `payments`, narx) | ✓ | ✗ — javobdan olib tashlanadi |
| Bronni tahrirlash, holat, to'lov, xodim biriktirish | ✓ | 403 |
| Moliya, xarajatlar, menyu/taom yozish, xodim boshqarish, rasmlar, to'yxona profili | ✓ | 403 |

## Kirish

| | |
|---|---|
| `POST /auth/login` `{phone, password}` | → `{token, roles:['owner'\|'staff']}` (10 daqiqalik kirish tokeni). Noto'g'ri telefon va noto'g'ri parol — bir xil 401. Bloklangan to'yxona — 403 + sabab |
| `GET /auth/session?role=` | kirish tokeni → rol tokeni `{token, user:{id,phone,name,role,venue_id,venue_name}}`. Rol tokeni bilan — sessiyani tekshirish |
| `POST /auth/forgot` `{phone}` | SMS kod (10 daq). Telefon mavjud bo'lmasa ham bir xil javob. Dev/test'da `dev_code` qaytadi |
| `POST /auth/reset` `{phone, code, password≥6}` | parolni almashtiradi; **barcha eski sessiyalar bekor** (`token_version`). 5 noto'g'ri urinishdan keyin kod bekor |
| `DELETE /account` | hisobni o'chirish (egasi: hisob nofaol, to'yxona ma'lumotlari saqlanadi; xodim: kirish olib tashlanadi) |

Bir telefon ham egasi, ham xodim bo'lishi mumkin — `roles` ikkala rolni qaytaradi.
Egasi akkaunti telefonini admin beradi: `PUT /api/admin/venues/:id/account { login, password, phone, name }`.

## Bronlar (egasi qo'lda kiritgan + Lokma ilovasi orqali kelgan — bir xil shaklda)

`source: 'owner' | 'app'`. Bosqichlar: `pending` (Yangi) → `deposit` (zakalat kutilmoqda) → `confirmed` → `completed`; `cancelled`.

| | |
|---|---|
| `GET /bookings?from&to&q&status&limit` | ro'yxat (standart: −90…+400 kun) |
| `GET /bookings/:id` | bitta bron (arxivdagi bekor qilinganlar ham) |
| `POST /bookings` | yaratish (`hall_id, date, session, event_type, customer_name, customer_phone, guests, total, menu_id?, stage?, notes?, start_time?, end_time?`). Band seans — 409 `slot_taken` |
| `PATCH /bookings/:id` | tahrirlash (faqat egasi; seans ko'chsa eski bo'shaydi). Lokma broni uchun faqat `notes` |
| `POST /bookings/:id/status` `{status}` | holat. Lokma broni `pending`/`deposit`ga qaytmaydi. `cancelled` — arxivga, seans bo'shaydi |
| `POST /bookings/:id/payments` `{kind: deposit\|payment\|refund, amount, method, note?}` | to'lov. Qoldiqdan ortiq — 422. Birinchi to'lov `pending/deposit` ni `confirmed` qiladi (Lokma broni — seansni `booked` qiladi) |
| `PUT /bookings/:id/staff` `{employee_ids}` | ishchilar biriktirish |
| `POST /bookings/quote` | narx taklifi — mijoz ilovasi bilan **bir xil formula** (`lib/pricing.ts`) |
| `GET /bookings/availability?date` | zal × seans bandligi va kim band qilgani |
| `GET /calendar?month=YYYY-MM` | oy bronlari + qo'lda yopilgan seanslar |
| `GET /clients?q` | mijozlar (telefon bo'yicha jamlanadi; qidiruv ism yoki telefon, bo'shliqlar e'tiborsiz) |

To'lov usullari: `cash, card, transfer, click, payme, other`.

## Menyu, taomlar, to'yxona

| | |
|---|---|
| `GET/POST /menus`, `PATCH/DELETE /menus/:id` | `{name, price_per_person, min_guests?, dishes:[nom], photo_public_id?}`. Taomlar nomi bilan qo'shiladi (katalogda bo'lmasa yaratiladi); `items_text` (mijoz ilovasi ko'rsatadigan matn) avtomatik yangilanadi. `min_guests` onlayn bronda ham tekshiriladi. Oxirgi paketni o'chirib bo'lmaydi |
| `GET/POST /dishes`, `PATCH/DELETE /dishes/:id` | `{name, photo_public_id?}`; o'chirilsa menyulardan ham olib tashlanadi |
| `GET /me` | to'yxona, zallar, seanslar, tadbir turlari, ruxsatlar, obuna holati (`free\|ok\|expiring\|overdue`) |
| `PATCH /venue` | `description, address, phone, amenities, parking_spots` (boshqa maydonlar e'tiborsiz) |

## Moliya (faqat egasi)

| | |
|---|---|
| `GET /finance/overview` | `revenue, deposit, paid, expenses, remaining, growth_percent, today_income, today_growth_percent, expected, expected_clients` |
| `GET /finance/operations?month&type=income\|expense` | to'lovlar (egasi + Lokma + bekor qilingan bronlar) va xarajatlar bir ro'yxatda |
| `POST /transactions`, `DELETE /transactions/:id` | xarajat/kirim. Kategoriyalar — `owner.models.ts` |

Daromad = zakalat + to'lov − qaytarish + boshqa kirimlar. Bosh sahifa, moliya va bron tafsiloti bir xil hisobdan foydalanadi.

## Xodimlar

`GET /employees` (xodimga faqat ism/lavozim/telefon), `POST/PATCH/DELETE /employees` (egasi). `app_access: true` + `app_password`
(≥6) — xodim ilovaga shu telefon va parol bilan kiradi. Parol almashsa yoki o'chirilsa sessiyasi darhol yopiladi.

## Rasmlar (Cloudinary)

1. `POST /uploads/sign {purpose: venue_photo|dish_photo|menu_photo}` (egasi) → `{upload_url, public_id, fields}`.
2. Ilova rasmni qurilmada ≤1600 px ga siqadi va `fields` + `file` ni `upload_url` ga multipart POST qiladi (to'g'ridan-to'g'ri Cloudinary'ga).
3. `POST /venue/photos {public_id}` / `photo_public_id` (taom, menyu) — server `public_id` shu to'yxona papkasiga
   (`<CLOUDINARY_FOLDER>/venues/<venueId>/<gallery|dishes|menus>/…`) tegishli ekanini va rasm mavjudligini (Admin API)
   tekshiradi, **URL'ni o'zi quradi**. `PUT /venue/photos/order {ids}` — tartib (birinchisi muqova), `DELETE /venue/photos/:id` —
   Cloudinary'dan ham o'chiradi.
4. Mijoz ilovasi `venue.photos` ni o'zgarishsiz o'qiydi: detalda `w_1600`, ro'yxatda `w_900` (`f_auto,q_auto`).

Imzo: parametrlar alifbo tartibida `k=v&…` + `API_SECRET`, SHA-1. `allowed_formats` va `overwrite=false` imzoga kiradi.

## Yangi to'yxona arizasi (ommaviy)

`POST /applications/uploads/sign` (rasm chiptasi, IP bo'yicha limit) → `POST /applications {name,address,phone,halls,capacity,services,photos:[public_id],price_from?,price_to?,notes?}`.
Bir telefondan 24 soatda takroriy ariza yangi yozuv ochmaydi. Admin: `GET /api/admin/applications`, `PATCH /api/admin/applications/:id {status, admin_note}`.

## Sozlamalar (`.env`)

| O'zgaruvchi | |
|---|---|
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | rasm yuklash. Sozlanmasa 503 `cloudinary_not_configured` |
| `CLOUDINARY_FOLDER` (`lokma-toyxonalar`), `CLOUDINARY_VERIFY` (`auto`) | ildiz papka; yuklangan rasm mavjudligini tekshirish |
| `SMS_PROVIDER=eskiz`, `ESKIZ_EMAIL`, `ESKIZ_PASSWORD`, `ESKIZ_FROM`, `SMS_TEMPLATE` | parol tiklash kodi. Production'da SMS sozlanmasa 503 |
| `OWNER_TOKEN_EXPIRES_IN` (`30d`) | ilova tokeni muddati |
| `CORS_ORIGINS` | ilovaning web versiyasi (Vercel) domeni |
