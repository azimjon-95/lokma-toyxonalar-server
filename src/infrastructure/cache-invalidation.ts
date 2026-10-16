import type { Schema } from 'mongoose';
import { bump, type Dep } from './cache.js';

/**
 * Model yozuvlari (save, update*, delete*, insertMany, bulkWrite...) kesh versiyasini oshiradi.
 * Shunda server ichidagi HAR QANDAY yozuv yo'li (admin, egasi ilovasi, bron, cron) keshni o'zi bekor qiladi —
 * har bir joyga alohida `invalidate()` chaqirig'i yozish va unutib qo'yish xavfi yo'q.
 */
export function invalidateOn(schema: Schema, dep: Dep) {
  const fire = () => bump(dep);
  schema.post('save', fire);
  schema.post('insertMany', fire);
  schema.post('bulkWrite' as never, fire);
  schema.post(['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'replaceOne', 'deleteMany'] as never, { document: false, query: true } as never, fire);
  schema.post('deleteOne', { document: true, query: true }, fire);
}
