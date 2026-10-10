import { Types } from 'mongoose';
import { badRequest, conflict, notFound } from '../../lib/http-error.js';
import { EVENT_TYPES, SESSION_LABELS } from '../../lib/sessions.js';
import { EVENT_LABELS } from './owner-app.dto.js';
import { BookingModel } from '../bookings/booking.model.js';
import { CancelledReservationModel, ReservationModel } from '../owner/owner.models.js';
import { VenueModel, type VenueDoc } from '../venues/venue.model.js';
import {
  assertOwnedPublicId, cloudinaryConfig, createUploadTicket, destroyAsset, imageUrl, requireCloudinary, venuePrefix, verifyAsset,
  type ImageAsset, type UploadKind,
} from '../cloudinary/cloudinary.service.js';
import { DishModel } from './owner-app.models.js';
import type { OwnerCtx } from './owner-app.auth.js';

const MAX_PHOTOS = 40;

/* ═══ RASM DTO ═══ */
type AssetLike = Partial<ImageAsset> & { url?: string | null; _id?: Types.ObjectId };

export function photoDto(a: AssetLike | null | undefined) {
  if (!a) return null;
  if (a.public_id) {
    return {
      public_id: a.public_id, url: imageUrl({ public_id: a.public_id, version: a.version }, 'large'),
      card_url: imageUrl({ public_id: a.public_id, version: a.version }, 'card'),
      thumb_url: imageUrl({ public_id: a.public_id, version: a.version }, 'thumb'),
      width: a.width ?? null, height: a.height ?? null, external: false,
    };
  }
  // Cloudinary'dan tashqari (eski) rasm — o'sha URL hamma o'lchamda
  return a.url ? { public_id: null, url: a.url, card_url: a.url, thumb_url: a.url, width: null, height: null, external: true } : null;
}

/* ═══ YUKLASH CHIPTASI ═══ */
export type UploadPurpose = 'venue_photo' | 'dish_photo' | 'menu_photo';
const PURPOSE_KIND: Record<UploadPurpose, UploadKind> = { venue_photo: 'gallery', dish_photo: 'dishes', menu_photo: 'menus' };

export function signUpload(c: OwnerCtx, purpose: UploadPurpose) {
  const cfg = requireCloudinary();
  return createUploadTicket(`${venuePrefix(String(c.venueId), cfg)}/${PURPOSE_KIND[purpose]}`, cfg);
}

/** Ilova yuborgan public_id'ni tekshiradi (egasi, papka, mavjudlik) va metama'lumotni qaytaradi */
async function acceptAsset(c: OwnerCtx, publicId: string, kind: UploadKind): Promise<ImageAsset> {
  const cfg = requireCloudinary();
  assertOwnedPublicId(publicId, `${venuePrefix(String(c.venueId), cfg)}/${kind}`);
  return verifyAsset(publicId, cfg);
}

const cleanup = (publicIds: (string | undefined | null)[]) => {
  // Cloudinary'dagi eski faylni o'chirish — fon rejimida, xatolik foydalanuvchiga ta'sir qilmaydi
  for (const id of publicIds) if (id) void destroyAsset(id, cloudinaryConfig());
};

/* ═══ TO'YXONA PROFILI ═══ */
const loadVenue = async (c: OwnerCtx) => {
  const v = await VenueModel.findById(c.venueId);
  if (!v) throw notFound('To‘yxona topilmadi');
  return v;
};

export async function meDto(c: OwnerCtx) {
  const v = await VenueModel.findById(c.venueId).lean();
  if (!v) throw notFound('To‘yxona topilmadi');
  const paidUntil = v.subscription?.paid_until ?? '';
  return {
    venue: {
      id: String(v._id), name: v.name, district: v.district, address: v.address, phone: v.phone, description: v.description,
      amenities: v.amenities ?? [], parking_spots: v.parking_spots, status: v.status,
      halls: v.halls.map((h) => ({ id: String(h._id), name: h.name, capacity_min: h.capacity_min, capacity_max: h.capacity_max })),
      sessions: v.sessions.map((s) => ({
        code: s.code, label: SESSION_LABELS[s.code as keyof typeof SESSION_LABELS], start_time: s.start_time, end_time: s.end_time,
        event_types: s.event_types, pricing_mode: s.pricing_mode ?? 'per_guest', price_factor: s.price_factor,
        fixed_price: s.fixed_price ?? 0, min_guests: s.min_guests, note: s.note ?? '',
      })),
      weekend_factor: v.weekend_factor, deposit_percent: v.deposit_percent,
      subscription: { monthly_fee: v.subscription?.monthly_fee ?? 0, paid_until: paidUntil, state: subscriptionState(v.subscription?.monthly_fee ?? 0, paidUntil) },
      rating: v.rating, reviews_count: v.reviews_count,
    },
    user: { id: String(c.subjectId), role: c.role, name: c.name, phone: c.phone },
    event_types: EVENT_TYPES.map((code) => ({ code, label: EVENT_LABELS[code] })),
    permissions: {
      money: c.role === 'owner', edit_bookings: c.role === 'owner', manage_menu: c.role === 'owner',
      manage_staff: c.role === 'owner', manage_photos: c.role === 'owner',
    },
  };
}

/** Obuna holati: free (to'lov yo'q) | ok | expiring (7 kun ichida tugaydi) | overdue */
export function subscriptionState(fee: number, paidUntil: string, today = new Date().toISOString().slice(0, 10)) {
  if (!fee) return 'free';
  if (!paidUntil || paidUntil < today) return 'overdue';
  const soon = new Date(`${today}T00:00:00Z`); soon.setUTCDate(soon.getUTCDate() + 7);
  return paidUntil <= soon.toISOString().slice(0, 10) ? 'expiring' : 'ok';
}

export interface ProfilePatch { description?: string; address?: string; phone?: string; amenities?: string[]; parking_spots?: number }
export async function patchVenue(c: OwnerCtx, p: ProfilePatch) {
  const v = await loadVenue(c);
  if (p.description !== undefined) v.description = p.description;
  if (p.address !== undefined) v.address = p.address;
  if (p.phone !== undefined) v.phone = p.phone;
  if (p.amenities !== undefined) v.amenities = p.amenities;
  if (p.parking_spots !== undefined) v.parking_spots = p.parking_spots;
  await v.save();
  return meDto(c);
}

/* ═══ GALEREYA ═══ */
/** Eski `photos` (oddiy URL'lar) birinchi marta boshqarilganda assetlarga ko'chiriladi */
function ensureAssets(v: VenueDoc) {
  if (!v.photo_assets.length && v.photos.length) {
    for (const url of v.photos) v.photo_assets.push({ url } as never);
  }
}
/** Mijoz ilovasi o'qiydigan `photos` ro'yxatini assetlardan yig'adi (birinchisi — muqova) */
function syncPhotos(v: VenueDoc) {
  v.photos = v.photo_assets.map((a) => (a.public_id ? imageUrl({ public_id: a.public_id, version: a.version ?? undefined }, 'large') : a.url ?? '')).filter(Boolean) as never;
}
const galleryDto = (v: VenueDoc) => v.photo_assets.map((a, i) => ({ id: String(a._id), ...photoDto(a as AssetLike), is_cover: i === 0 }));

export async function listPhotos(c: OwnerCtx) {
  const v = await loadVenue(c);
  if (!v.photo_assets.length && v.photos.length) { ensureAssets(v); await v.save(); }
  return galleryDto(v);
}

export async function addPhoto(c: OwnerCtx, publicId: string) {
  const asset = await acceptAsset(c, publicId, 'gallery');
  const v = await loadVenue(c);
  ensureAssets(v);
  if (v.photo_assets.length >= MAX_PHOTOS) { cleanup([publicId]); throw conflict(`Ko‘pi bilan ${MAX_PHOTOS} ta rasm`, 'limit'); }
  if (v.photo_assets.some((a) => a.public_id === publicId)) return galleryDto(v); // takroriy so'rov — bir xil natija
  v.photo_assets.push({ public_id: publicId, version: asset.version, width: asset.width, height: asset.height, bytes: asset.bytes, format: asset.format } as never);
  syncPhotos(v);
  await v.save();
  return galleryDto(v);
}

export async function removePhoto(c: OwnerCtx, id: string) {
  const v = await loadVenue(c);
  ensureAssets(v);
  const i = v.photo_assets.findIndex((a) => String(a._id) === id);
  if (i < 0) throw notFound('Rasm topilmadi');
  const [gone] = v.photo_assets.splice(i, 1);
  syncPhotos(v);
  await v.save();
  cleanup([gone.public_id]);
  return galleryDto(v);
}

export async function reorderPhotos(c: OwnerCtx, ids: string[]) {
  const v = await loadVenue(c);
  ensureAssets(v);
  const have = v.photo_assets.map((a) => String(a._id));
  if (ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((x) => have.includes(x))) throw badRequest('Rasmlar ro‘yxati mos emas');
  v.photo_assets = ids.map((x) => v.photo_assets.find((a) => String(a._id) === x)!) as never;
  syncPhotos(v);
  await v.save();
  return galleryDto(v);
}

/* ═══ TAOMLAR ═══ */
const nameKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const cleanName = (s: string) => s.trim().replace(/\s+/g, ' ');

interface DishLike { _id: Types.ObjectId; name: string; photo?: Partial<ImageAsset> | null }
const dishDto = (d: DishLike, menusCount = 0) => ({ id: String(d._id), name: d.name, photo: photoDto(d.photo ?? null), menus_count: menusCount });

export async function listDishes(c: OwnerCtx) {
  const [dishes, v] = await Promise.all([DishModel.find({ venue_id: c.venueId }).sort({ name_key: 1 }).lean(), VenueModel.findById(c.venueId, { menu_packages: 1 }).lean()]);
  const counts = new Map<string, number>();
  for (const m of v?.menu_packages ?? []) for (const id of m.dishes ?? []) counts.set(String(id), (counts.get(String(id)) ?? 0) + 1);
  return dishes.map((d) => dishDto(d as unknown as DishLike, counts.get(String(d._id)) ?? 0));
}

export async function createDish(c: OwnerCtx, name: string, photoPublicId?: string) {
  const n = cleanName(name);
  if (await DishModel.exists({ venue_id: c.venueId, name_key: nameKey(n) })) throw conflict('Bunday taom allaqachon bor', 'duplicate');
  const photo = photoPublicId ? await acceptAsset(c, photoPublicId, 'dishes') : undefined;
  const d = await DishModel.create({ venue_id: c.venueId, name: n, name_key: nameKey(n), photo });
  return dishDto(d.toObject() as unknown as DishLike);
}

export async function updateDish(c: OwnerCtx, id: string, p: { name?: string; photo_public_id?: string | null }) {
  const d = await DishModel.findOne({ _id: id, venue_id: c.venueId });
  if (!d) throw notFound('Taom topilmadi');
  const oldPhoto = d.photo?.public_id;
  if (p.name !== undefined) {
    const n = cleanName(p.name);
    const dup = await DishModel.exists({ venue_id: c.venueId, name_key: nameKey(n), _id: { $ne: d._id } });
    if (dup) throw conflict('Bunday taom allaqachon bor', 'duplicate');
    d.name = n; d.name_key = nameKey(n);
  }
  if (p.photo_public_id !== undefined) {
    d.photo = (p.photo_public_id ? await acceptAsset(c, p.photo_public_id, 'dishes') : undefined) as never;
  }
  await d.save();
  if (p.photo_public_id !== undefined && oldPhoto && oldPhoto !== d.photo?.public_id) cleanup([oldPhoto]);
  if (p.name !== undefined) await rebuildItemsText(c);
  return dishDto(d.toObject() as unknown as DishLike);
}

export async function deleteDish(c: OwnerCtx, id: string) {
  const d = await DishModel.findOneAndDelete({ _id: id, venue_id: c.venueId }).lean();
  if (!d) throw notFound('Taom topilmadi');
  const v = await loadVenue(c);
  for (const m of v.menu_packages) m.dishes = m.dishes.filter((x) => String(x) !== id) as never;
  await v.save();
  await rebuildItemsText(c);
  cleanup([d.photo?.public_id]);
  return { ok: true };
}

/* ═══ MENYU PAKETLARI ═══ */
export interface MenuInput { name: string; price_per_person: number; min_guests?: number; dishes?: string[]; photo_public_id?: string | null }

/** Nomlar bo'yicha taomlarni topadi yoki yaratadi; tartibni saqlaydi */
async function resolveDishes(c: OwnerCtx, names: string[]): Promise<Types.ObjectId[]> {
  const seen = new Set<string>(); const out: Types.ObjectId[] = [];
  for (const raw of names) {
    const n = cleanName(raw); const key = nameKey(n);
    if (!n || seen.has(key)) continue;
    seen.add(key);
    const d = await DishModel.findOneAndUpdate({ venue_id: c.venueId, name_key: key }, { $setOnInsert: { name: n, name_key: key } }, { upsert: true, returnDocument: 'after' }).lean();
    out.push(d!._id as Types.ObjectId);
  }
  return out;
}

async function dishNames(ids: Types.ObjectId[]) {
  const ds = await DishModel.find({ _id: { $in: ids } }, { name: 1 }).lean();
  const by = new Map(ds.map((d) => [String(d._id), d.name]));
  return ids.map((i) => by.get(String(i))).filter(Boolean) as string[];
}

/** Mijoz ilovasi `items_text` ko'rsatadi — taomlar o'zgarganda qayta yig'iladi */
async function rebuildItemsText(c: OwnerCtx) {
  const v = await loadVenue(c);
  for (const m of v.menu_packages) m.items_text = (await dishNames(m.dishes as unknown as Types.ObjectId[])).join(', ');
  await v.save();
}

export async function listMenus(c: OwnerCtx) {
  const v = await VenueModel.findById(c.venueId, { menu_packages: 1 }).lean();
  if (!v) throw notFound('To‘yxona topilmadi');
  const allIds = v.menu_packages.flatMap((m) => m.dishes ?? []);
  const [dishes, resCounts, appCounts] = await Promise.all([
    DishModel.find({ _id: { $in: allIds } }).lean(),
    ReservationModel.aggregate([{ $match: { venue_id: c.venueId, menu_id: { $ne: '' } } }, { $group: { _id: '$menu_id', n: { $sum: 1 } } }]),
    BookingModel.aggregate([{ $match: { venue_id: c.venueId, status: { $ne: 'cancelled' } } }, { $group: { _id: '$menu.id', n: { $sum: 1 } } }]),
  ]);
  const used = new Map<string, number>();
  for (const x of [...resCounts, ...appCounts]) if (x._id) used.set(String(x._id), (used.get(String(x._id)) ?? 0) + x.n);
  const top = Math.max(0, ...used.values());
  const by = new Map(dishes.map((d) => [String(d._id), d]));
  return v.menu_packages.map((m) => {
    const list = (m.dishes ?? []).map((id) => by.get(String(id))).filter(Boolean) as unknown as DishLike[];
    const n = used.get(String(m._id)) ?? 0;
    return {
      id: String(m._id), name: m.name, price_per_person: m.price_per_guest, min_guests: m.min_guests ?? 0,
      dishes: list.map((d) => dishDto(d)), items_text: m.items_text, photo: photoDto(m.photo as AssetLike | null),
      used_count: n, popular: top > 0 && n === top,
    };
  });
}

export async function createMenu(c: OwnerCtx, i: MenuInput) {
  const v = await loadVenue(c);
  if (v.menu_packages.some((m) => nameKey(m.name) === nameKey(i.name))) throw conflict('Bunday nomli menyu allaqachon bor', 'duplicate');
  const ids = await resolveDishes(c, i.dishes ?? []);
  const photo = i.photo_public_id ? await acceptAsset(c, i.photo_public_id, 'menus') : undefined;
  v.menu_packages.push({ name: cleanName(i.name), price_per_guest: i.price_per_person, min_guests: i.min_guests ?? 0, dishes: ids, items_text: (await dishNames(ids)).join(', '), photo } as never);
  await v.save();
  const menus = await listMenus(c);
  return menus.find((m) => m.id === String(v.menu_packages[v.menu_packages.length - 1]._id))!;
}

export async function updateMenu(c: OwnerCtx, id: string, p: Partial<MenuInput>) {
  const v = await loadVenue(c);
  const m = v.menu_packages.id(id);
  if (!m) throw notFound('Menyu topilmadi');
  const oldPhoto = m.photo?.public_id;
  if (p.name !== undefined) {
    if (v.menu_packages.some((x) => String(x._id) !== id && nameKey(x.name) === nameKey(p.name!))) throw conflict('Bunday nomli menyu allaqachon bor', 'duplicate');
    m.name = cleanName(p.name);
  }
  if (p.price_per_person !== undefined) m.price_per_guest = p.price_per_person;
  if (p.min_guests !== undefined) m.min_guests = p.min_guests;
  if (p.dishes !== undefined) {
    const ids = await resolveDishes(c, p.dishes);
    m.dishes = ids as never;
    m.items_text = (await dishNames(ids)).join(', ');
  }
  if (p.photo_public_id !== undefined) m.photo = (p.photo_public_id ? await acceptAsset(c, p.photo_public_id, 'menus') : undefined) as never;
  await v.save();
  if (p.photo_public_id !== undefined && oldPhoto && oldPhoto !== m.photo?.public_id) cleanup([oldPhoto]);
  return (await listMenus(c)).find((x) => x.id === id)!;
}

export async function deleteMenu(c: OwnerCtx, id: string) {
  const v = await loadVenue(c);
  const m = v.menu_packages.id(id);
  if (!m) throw notFound('Menyu topilmadi');
  if (v.menu_packages.length <= 1) throw conflict('Kamida bitta menyu paketi qolishi kerak', 'last_menu');
  const photo = m.photo?.public_id;
  // $pull o'rniga massivni to'liq almashtiramiz — har qanday Mongo-mos bazada bir xil ishlaydi
  v.menu_packages = v.menu_packages.filter((x) => String(x._id) !== id) as never;
  await v.save();
  cleanup([photo]);
  return { ok: true };
}

/** Hisobotlarda ishlatilmasin deb — bekor qilingan egasi bronlari ham menyu ishlatilishi hisobiga kirmaydi */
void CancelledReservationModel;
