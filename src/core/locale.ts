/**
 * 当前界面语言。独立成模块：网络层要用它拼 Accept-Language，
 * 而字典按使用面拆分（内容脚本只带两张表），这里不能反向依赖任何字典。
 */
import { signal } from "@preact/signals";
// 叶子模块：桶文件（@xlear/shared）会把 zod 与四个语言的字典一起带进内容脚本产物。
import { normalizeLocale, type Locale } from "../../shared/i18n/index.ts";
import { browser } from "wxt/browser";

export const localeSignal = signal<Locale>("en");

function browserLocale(): Locale {
  try {
    return normalizeLocale(browser.i18n.getUILanguage()) ?? "en";
  } catch {
    return "en";
  }
}

export function applyLocale(configured: "auto" | Locale): Locale {
  localeSignal.value = configured === "auto" ? browserLocale() : configured;
  return localeSignal.value;
}
