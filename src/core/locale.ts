/**
 * 当前界面语言。独立成模块：网络层要用它拼 Accept-Language，
 * 而字典按使用面拆分（内容脚本只带两张表），这里不能反向依赖任何字典。
 */
import { signal } from "@preact/signals";
// 只取叶子模块，不经过桶文件：内容脚本的产物越小越好。
import { normalizeLocale, type Locale } from "../../contract/i18n/index.ts";
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
