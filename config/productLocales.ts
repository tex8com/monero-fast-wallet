export const productLocales = [
  { code: 'en', tag: 'en-US', nativeName: 'English', direction: 'ltr' },
  { code: 'de', tag: 'de-DE', nativeName: 'Deutsch', direction: 'ltr' },
  { code: 'es', tag: 'es-ES', nativeName: 'Español', direction: 'ltr' },
  { code: 'pt-BR', tag: 'pt-BR', nativeName: 'Português (Brasil)', direction: 'ltr' },
  { code: 'ru', tag: 'ru-RU', nativeName: 'Русский', direction: 'ltr' },
  { code: 'vi', tag: 'vi-VN', nativeName: 'Tiếng Việt', direction: 'ltr' },
  { code: 'id', tag: 'id-ID', nativeName: 'Bahasa Indonesia', direction: 'ltr' },
  { code: 'uk', tag: 'uk-UA', nativeName: 'Українська', direction: 'ltr' },
  { code: 'tr', tag: 'tr-TR', nativeName: 'Türkçe', direction: 'ltr' },
  { code: 'hi', tag: 'hi-IN', nativeName: 'हिन्दी', direction: 'ltr' },
  { code: 'ur', tag: 'ur-PK', nativeName: 'اردو', direction: 'rtl' },
  { code: 'fr', tag: 'fr-FR', nativeName: 'Français', direction: 'ltr' },
  { code: 'fil', tag: 'fil-PH', nativeName: 'Filipino', direction: 'ltr' },
  { code: 'ja', tag: 'ja-JP', nativeName: '日本語', direction: 'ltr' },
  { code: 'ko', tag: 'ko-KR', nativeName: '한국어', direction: 'ltr' },
  { code: 'ar', tag: 'ar', nativeName: 'العربية', direction: 'rtl' },
  { code: 'zh-CN', tag: 'zh-CN', nativeName: '简体中文', direction: 'ltr' },
  { code: 'zh-TW', tag: 'zh-TW', nativeName: '繁體中文', direction: 'ltr' },
] as const;

export type ProductLanguageCode = (typeof productLocales)[number]['code'];
export type ProductTextDirection = (typeof productLocales)[number]['direction'];

export const productLanguageCodes = productLocales.map(locale => locale.code) as ProductLanguageCode[];
export const productLocaleByCode = Object.fromEntries(productLocales.map(locale => [locale.code, locale])) as Record<ProductLanguageCode, (typeof productLocales)[number]>;

export function matchProductLanguage(locale: string | null | undefined): ProductLanguageCode {
  if (!locale) return 'en';
  const normalized = locale.replace('_', '-').toLowerCase();
  if (normalized.startsWith('zh-tw') || normalized.startsWith('zh-hk') || normalized.startsWith('zh-hant')) return 'zh-TW';
  if (normalized.startsWith('zh')) return 'zh-CN';
  if (normalized.startsWith('pt')) return 'pt-BR';
  if (normalized.startsWith('fil') || normalized.startsWith('tl')) return 'fil';
  return productLocales.find(candidate => normalized === candidate.code.toLowerCase() || normalized.startsWith(`${candidate.code.toLowerCase()}-`))?.code ?? 'en';
}
