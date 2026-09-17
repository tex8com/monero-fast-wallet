import flagAr from 'flag-icons/flags/4x3/sa.svg';
import flagDe from 'flag-icons/flags/4x3/de.svg';
import flagEn from 'flag-icons/flags/4x3/us.svg';
import flagEs from 'flag-icons/flags/4x3/es.svg';
import flagFil from 'flag-icons/flags/4x3/ph.svg';
import flagFr from 'flag-icons/flags/4x3/fr.svg';
import flagHi from 'flag-icons/flags/4x3/in.svg';
import flagId from 'flag-icons/flags/4x3/id.svg';
import flagJa from 'flag-icons/flags/4x3/jp.svg';
import flagKo from 'flag-icons/flags/4x3/kr.svg';
import flagPtBr from 'flag-icons/flags/4x3/br.svg';
import flagRu from 'flag-icons/flags/4x3/ru.svg';
import flagTr from 'flag-icons/flags/4x3/tr.svg';
import flagUk from 'flag-icons/flags/4x3/ua.svg';
import flagUr from 'flag-icons/flags/4x3/pk.svg';
import flagVi from 'flag-icons/flags/4x3/vn.svg';
import flagZhCn from 'flag-icons/flags/4x3/cn.svg';
import flagZhTw from 'flag-icons/flags/4x3/tw.svg';
import type { ProductLanguageCode } from '../../../config/productLocales';

const flagByLanguage: Record<ProductLanguageCode, string> = {
  ar: flagAr,
  de: flagDe,
  en: flagEn,
  es: flagEs,
  fil: flagFil,
  fr: flagFr,
  hi: flagHi,
  id: flagId,
  ja: flagJa,
  ko: flagKo,
  'pt-BR': flagPtBr,
  ru: flagRu,
  tr: flagTr,
  uk: flagUk,
  ur: flagUr,
  vi: flagVi,
  'zh-CN': flagZhCn,
  'zh-TW': flagZhTw,
};

export default function LanguageFlag({ code }: { code: ProductLanguageCode }) {
  return <img aria-hidden="true" className="language-flag" draggable={false} src={flagByLanguage[code]} />;
}
