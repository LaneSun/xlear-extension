/**
 * 扩展页面侧（popup / options / onboarding / background）的本地化。
 *
 * 语言优先取用户配置；配置为 auto 时跟随浏览器界面语言，最终回退英文（主要语言）。
 * 内容脚本请改用 i18n.content.ts：它只带 COMMON + EXT 两张表，注入体积小得多。
 */
// 叶子模块导入：桶文件（@xlear/shared）会把 schemas 连带 zod 一起打进产物，扩展侧并不需要。
import { translate, type Params } from "../shared/i18n/index.ts";
import { DICT } from "../shared/i18n/bundle.ts";
import { applyLocale, localeSignal } from "./core/locale.ts";

export { applyLocale, localeSignal };

/** 翻译函数：读 `localeSignal`，语言变化时组件会自动重渲染。 */
export function t(key: string, params?: Params): string {
  return translate(DICT, localeSignal.value, key, params);
}

/**
 * 把语言写到文档上：`html[lang]` 影响断词与朗读，标题在扩展自己的页面里显示。
 * 静态 HTML 里只写英文兜底，切换语言后由这里覆盖。
 */
export function applyDocumentLocale(titleKey: string): void {
  document.documentElement.lang = localeSignal.value;
  document.title = t(titleKey);
}

/** 相对时间（刚刚 / N 分钟前 / …），按当前语言输出。 */
export function formatRelativeTime(ts: number | undefined): string {
  if (!ts) return t("common.never");
  const diff = Date.now() - ts;
  if (diff < 60_000) return t("common.justNow");
  if (diff < 3_600_000) return t("common.minutesAgo", { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("common.hoursAgo", { n: Math.floor(diff / 3_600_000) });
  return new Date(ts).toLocaleString(localeSignal.value);
}
