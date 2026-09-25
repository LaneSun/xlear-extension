/**
 * 内容脚本专用的语言模块。
 *
 * 内容脚本会在每个 X 页面上运行，而完整字典含四个语言的全部界面文案（约 110KB 源码）。
 * 它只需要卡片、弹窗与自动执行相关的文案，因此这里只合并 COMMON + EXT 两张表。
 * 注意只走相对路径导入叶子模块：`@xlear/shared` 桶文件会连带 schemas（zod）一起打进产物。
 */
import { translate, type Dict, type Params } from "../shared/i18n/index.ts";
import { COMMON_DICT } from "../shared/i18n/dict.common.ts";
import { EXT_DICT } from "../shared/i18n/dict.ext.ts";
import { applyLocale, localeSignal } from "./core/locale.ts";

export { applyLocale, localeSignal };

const CONTENT_DICT: Dict = { ...COMMON_DICT, ...EXT_DICT };

export function t(key: string, params?: Params): string {
  return translate(CONTENT_DICT, localeSignal.value, key, params);
}
