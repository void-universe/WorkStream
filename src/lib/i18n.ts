// 界面语言的唯一清单与字典读取。
//
// 18 种语言覆盖名义 GDP 前 26 国的官方/通用语言（IMF WEO 2025 年数、2026 年 4 月版），
// 顺序按国家在该名单里的位置：美/英/澳/爱/印 → en，中国 → zh-Hans，德国与瑞士、比利时 → de，以此类推。
// complete 为假的语言只在界面上列名、不可点：给一个「选了却仍然显示英文」的选项，比不提供更糟——
// 用户以为自己换了语言，实际没有，而这种落差没有任何报错会告诉他。
import { createContext, useContext } from "react";
import en from "../locales/en.json";
import zhHans from "../locales/zh-Hans.json";
import de from "../locales/de.json";
import ja from "../locales/ja.json";

export const LANG_STORAGE_KEY = "workstream.lang";

export const LOCALES = [
  { id: "en", label: "English", intl: "en", dir: "ltr", complete: true },
  { id: "zh-Hans", label: "简体中文", intl: "zh-Hans", dir: "ltr", complete: true },
  { id: "de", label: "Deutsch", intl: "de", dir: "ltr", complete: true },
  { id: "ja", label: "日本語", intl: "ja", dir: "ltr", complete: true },
  { id: "hi", label: "हिन्दी", intl: "hi", dir: "ltr", complete: false },
  { id: "fr", label: "Français", intl: "fr", dir: "ltr", complete: false },
  { id: "ru", label: "Русский", intl: "ru", dir: "ltr", complete: false },
  { id: "it", label: "Italiano", intl: "it", dir: "ltr", complete: false },
  { id: "pt-BR", label: "Português (Brasil)", intl: "pt-BR", dir: "ltr", complete: false },
  { id: "es", label: "Español", intl: "es", dir: "ltr", complete: false },
  { id: "ko", label: "한국어", intl: "ko", dir: "ltr", complete: false },
  { id: "tr", label: "Türkçe", intl: "tr", dir: "ltr", complete: false },
  { id: "id", label: "Bahasa Indonesia", intl: "id", dir: "ltr", complete: false },
  { id: "nl", label: "Nederlands", intl: "nl", dir: "ltr", complete: false },
  { id: "ar", label: "العربية", intl: "ar", dir: "rtl", complete: false },
  { id: "pl", label: "Polski", intl: "pl", dir: "ltr", complete: false },
  { id: "sv", label: "Svenska", intl: "sv", dir: "ltr", complete: false },
  { id: "he", label: "עברית", intl: "he", dir: "rtl", complete: false },
] as const;

export type LocaleId = (typeof LOCALES)[number]["id"];
export type LocaleMeta = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: LocaleId = "zh-Hans";

const BY_ID = new Map<string, LocaleMeta>(LOCALES.map((locale) => [locale.id, locale]));

export function isLocaleId(value: unknown): value is LocaleId {
  return typeof value === "string" && BY_ID.has(value);
}

export function localeOf(id: LocaleId): LocaleMeta {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_LOCALE)!;
}

/** 只认已经译完的语言：账户里可能存着后端接受、但界面还没译出文案的 id，那种值不能直接上屏。 */
export function isCompleteLang(value: unknown): value is LocaleId {
  return isLocaleId(value) && localeOf(value).complete;
}

const DICTS: Partial<Record<LocaleId, Record<string, string>>> = {
  "zh-Hans": zhHans,
  en,
  de,
  ja,
};

/** 键的类型来自中文源字典：打错一个键名是构建期错误，不留到运行时变一句空白。 */
export type MsgKey = keyof typeof zhHans;

const FALLBACK: LocaleId = "en";

export type I18n = {
  readonly lang: LocaleId;
  readonly intl: string;
  readonly dir: "ltr" | "rtl";
  /** 纯取词：字典里没有这个键时把键名显示出来，不静默给一个空串。 */
  readonly t: (key: MsgKey) => string;
  /** 带参数：`{name}` 占位整体替换，数字参数按当前 locale 落格式，句子永远是一次性取出来的。 */
  readonly tf: (key: MsgKey, params?: Record<string, string | number>) => string;
  /** 需要在一个 token 前后夹元素（比如 `<code>`）时用它：按 `{0}` 切开，段与段之间由调用方插入。 */
  readonly tp: (key: MsgKey) => string[];
  readonly number: (value: number) => string;
  /** 一串并列项的本地写法：中文用顿号、拉丁语用逗号加最后一个 and，别在界面里硬写「、」。 */
  readonly list: (items: string[]) => string;
};

function lookup(lang: LocaleId, key: string): string | undefined {
  return DICTS[lang]?.[key] ?? DICTS[FALLBACK]?.[key];
}

export function createI18n(lang: LocaleId): I18n {
  const meta = localeOf(lang);
  const numberFormat = new Intl.NumberFormat(meta.intl);
  const listFormat = new Intl.ListFormat(meta.intl, { style: "narrow", type: "conjunction" });

  const raw = (key: MsgKey): string => {
    const hit = lookup(lang, key);
    return hit ?? lookup(FALLBACK, key) ?? `⟦${String(key)}⟧`;
  };

  return {
    lang,
    intl: meta.intl,
    dir: meta.dir,
    t: raw,
    tf: (key, params) => {
      // 只替换一次且整体替换：参数值里带 `{` 不会被二次解释。
      const template = raw(key);
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) => {
        const value = params[name];
        if (value === undefined) return match;
        return typeof value === "number" ? numberFormat.format(value) : String(value);
      });
    },
    tp: (key) => raw(key).split("{0}"),
    number: (value) => numberFormat.format(value),
    list: (items) => listFormat.format(items),
  };
}

export const I18nContext = createContext<I18n>(createI18n(DEFAULT_LOCALE));

export function useI18n(): I18n {
  return useContext(I18nContext);
}

/** 界面语言由外到内的三个来源：账户偏好 > 本机偏好 > 浏览器语言，全都没有才落到产品原有语言。 */
export function readStoredLang(): LocaleId | null {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    return isCompleteLang(saved) ? saved : null;
  } catch {
    return null;
  }
}

const LANG_PENDING_KEY = "workstream.lang.pending";

/**
 * 语言门上亲手选过、还没同步给账户：下次登录以它为准。
 * 只靠内存里的标记活不过一次刷新——新设备上「选完再登录」经常隔着一次刷新，
 * 结果账户里的旧值把刚选的语言顶回去，看起来就像「登录后不能切语言」。
 */
export function markLangPending(): void {
  try {
    localStorage.setItem(LANG_PENDING_KEY, "1");
  } catch {
    /* 存不下就只在本次会话里认这一票 */
  }
}

export function readLangPending(): boolean {
  try {
    return localStorage.getItem(LANG_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearLangPending(): void {
  try {
    localStorage.removeItem(LANG_PENDING_KEY);
  } catch {
    /* 同上 */
  }
}

export function writeStoredLang(lang: LocaleId): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* 隐私模式下只用当前会话 */
  }
}

/**
 * 浏览器语言只认已经译完的几种：认不出的语言不能存下来，
 * 否则第一次访问就被永久钉在一个「选了却没生效」的语言上。
 */
export function pickFromNavigator(): LocaleId | null {
  const wanted = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of wanted) {
    if (!tag) continue;
    const exact = LOCALES.find((locale) => locale.complete && locale.intl.toLowerCase() === tag.toLowerCase());
    if (exact) return exact.id;
  }
  for (const tag of wanted) {
    const base = tag?.split("-")[0]?.toLowerCase();
    if (!base) continue;
    const loose = LOCALES.find((locale) => locale.complete && (locale.intl.toLowerCase() === base || locale.intl.toLowerCase().startsWith(`${base}-`)));
    if (loose) return loose.id;
  }
  return null;
}

export function resolveInitialLang(): LocaleId {
  return readStoredLang() ?? pickFromNavigator() ?? DEFAULT_LOCALE;
}

export function applyDocumentLocale(lang: LocaleId): void {
  const meta = localeOf(lang);
  const root = document.documentElement;
  root.lang = meta.intl;
  // dir 先只写基方向：从右到左的排版（物理方向类、气泡镜像、字体栈）是单独一批，
  // 现在就把 ar/he 放出来只会得到一个文案对、方向错的界面。
  root.dir = "ltr";
}
