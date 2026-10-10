/** O'zbekiston telefon raqamlari: +998XXXXXXXXX ko'rinishiga keltirish */
export function normalizePhone(input: string | null | undefined): string | null {
  const d = String(input ?? '').replace(/\D/g, '');
  if (d.length === 9) return `+998${d}`;
  if (d.length === 12 && d.startsWith('998')) return `+${d}`;
  return null;
}

/** Oxirgi 9 raqam — turli formatdagi yozuvlarni solishtirish uchun */
export const phoneTail = (v: string | null | undefined) => String(v ?? '').replace(/\D/g, '').slice(-9);
