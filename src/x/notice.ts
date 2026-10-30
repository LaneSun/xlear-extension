/** 操作回执放在可见区域；移动端不能依靠开发者控制台获知失败。 */
import { readTheme, themeVariables } from "./theme.ts";
import { t } from "../i18n.content.ts";

let dismiss: (() => void) | undefined;
export function showNotice(message: string): void {
  dismiss?.();
  const host = document.createElement("div");
  host.setAttribute("data-xlear-notice", "");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; ${themeVariables(readTheme())} }
    .notice { position: fixed; z-index: 2147483001; left: 12px; right: 12px;
      bottom: max(76px, calc(env(safe-area-inset-bottom) + 60px)); margin: auto;
      width: max-content; max-width: min(520px, calc(100vw - 24px)); box-sizing: border-box;
      padding: 12px 16px; border: 1px solid var(--xlear-border); border-radius: 16px;
      background: var(--xlear-panel); color: var(--xlear-text); font: 14px/20px var(--xlear-font);
      display: flex; align-items: center; gap: 12px; box-shadow: 0 4px 24px #0003; }
    span { min-width: 0; overflow-wrap: anywhere; }
    button { background: transparent; color: var(--xlear-accent); border: 0;
      min-height: 44px; font: inherit; font-weight: 700; cursor: pointer; }
  `;
  const box = document.createElement("div");
  box.className = "notice";
  box.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = t("common.close");
  const remove = () => {
    clearTimeout(timer);
    host.remove();
    if (dismiss === remove) dismiss = undefined;
  };
  close.addEventListener("click", remove);
  const timer = setTimeout(remove, 12_000);
  dismiss = remove;
  box.append(text, close);
  shadow.append(style, box);
  document.body.append(host);
}
