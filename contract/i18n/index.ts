/**
 * 本地化基础设施（中 / 英 / 日 / 俄，英文为主要语言）。
 *
 * 设计：所有文案集中成"一行四列"的字典，键相同、四列分别是 en/zh/ja/ru。
 * 这样新增语言只是加一列，漏翻一眼就能看出来，也不会出现四份键名对不齐的情况。
 *
 * 只有一份、无法按读者切换的内容一律用英文，
 * 因为它们只有一份，无法按请求语言切换。
 */

export const LOCALES = ["en", "zh", "ja", "ru"] as const;
export type Locale = typeof LOCALES[number];

function isLocale(value: string | null | undefined): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** 一行四列的字典：`键: [en, zh, ja, ru]`。 */
export type Dict = Record<string, readonly [string, string, string, string]>;

export type Params = Record<string, string | number>;

const INDEX: Record<Locale, number> = { en: 0, zh: 1, ja: 2, ru: 3 };

/**
 * 取一条文案。`params` 会替换文本里的 `{name}` 占位符。
 * 找不到键时返回键名本身 —— 宁可显示键名，也不要让页面静默空白。
 */
export function translate(dict: Dict, locale: Locale, key: string, params?: Params): string {
  const row = dict[key];
  if (!row) return key;
  let text = row[INDEX[locale]] || row[0];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/** 把任意输入（URL 参数、配置值）归一化成受支持的 locale。 */
export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const lower = value.trim().toLowerCase();
  if (isLocale(lower)) return lower;
  const base = lower.split(/[-_]/)[0];
  return isLocale(base) ? base : null;
}
