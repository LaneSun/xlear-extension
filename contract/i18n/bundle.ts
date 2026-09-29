/**
 * 扩展页面的合并表：只合并 COMMON 与 EXT 两张表。
 *
 * 合并时检查键冲突并直接抛错：静默覆盖会让某个区域的文案消失得毫无痕迹。
 * 内容脚本只需要 COMMON，因此从叶子模块单独导入，避免把整张表打进去。
 */
import type { Dict } from "./index.ts";
import { COMMON_DICT } from "./dict.common.ts";
import { EXT_DICT } from "./dict.ext.ts";

function mergeDicts(parts: { name: string; dict: Dict }[]): Dict {
  const merged: Dict = {};
  for (const { name, dict } of parts) {
    for (const [key, row] of Object.entries(dict)) {
      if (key in merged) throw new Error(`i18n 键冲突：${key}（来自 ${name}）`);
      merged[key] = row;
    }
  }
  return merged;
}

export const DICT: Dict = mergeDicts([
  { name: "common", dict: COMMON_DICT },
  { name: "ext", dict: EXT_DICT },
]);
