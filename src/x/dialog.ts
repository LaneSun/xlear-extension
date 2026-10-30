/**
 * 「屏蔽理由」弹窗。
 *
 * 需求是「用理由选择弹窗替换 X 原本的屏蔽确认弹窗」。实现上并不拦截 X 的行为：
 * X 仍然会打开它自己的确认弹窗，我们把它藏起来，然后复用它的确认按钮 ——
 * 这样屏蔽请求依旧由 X 自己发出（不逆向签名），我们只是插入了一步理由选择。
 *
 * 同一个外壳还承载卡片上的确认弹窗（例如「不再隐藏」），两者共享样式与交互约定：
 * 标题 + 按钮区（主按钮一行、取消一行）、Esc 与点遮罩等于取消。
 *
 * 用 Shadow DOM 承载以避免与 X 的全局样式互相污染；这里刻意不用 Preact：
 * 内容脚本的打包环境里组件框架与页面脚本共用同一套 hooks 状态时容易出现实例不一致，
 * 而这个弹窗只有一点点状态，用原生 DOM 反而更小更稳。
 */
import { observeTheme, themeVariables } from "./theme.ts";
import { lockPageScroll } from "../ui/scroll-lock.ts";
import { type ReasonHistory, recentReasonLists } from "../core/reason-history.ts";

export interface DialogList {
  id: string;
  name: string;
  reason: string;
}

export type DialogResult =
  | { kind: "confirm"; listIds: string[] }
  | { kind: "cancel" };

export interface DialogOptions {
  screenName?: string;
  lists: DialogList[];
  history?: ReasonHistory;
  /** 已翻译的文案（内容脚本用共享字典解析后传入）。 */
  strings: {
    /** 含 {user} 占位符。 */
    title: string;
    ariaLabel: string;
    confirm: string;
    processing: string;
    cancel: string;
    reusePrevious: string;
    /** 含 {lists} 占位符。 */
    reusePreviousHint: string;
  };
}

const HOST_ID = "xlear-dialog-host";
let cancelActive: (() => void) | undefined;

/** 总开关关闭或内容脚本失效时，取消尚未完成的交互。 */
export function closeDialog(): void {
  cancelActive?.();
}

const DIALOG_CSS = `
  /* 手机浏览器（X 移动网页）视口窄，内边距按视口缩放、留出两侧空隙。 */
  :host { all: initial; --sheet-pad: clamp(16px, 5vw, 28px); }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--xlear-mask, rgba(91, 112, 131, 0.4));
    font-family: var(--xlear-font);
    box-sizing: border-box;
    padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
    overscroll-behavior: contain;
  }
  .sheet {
    width: min(360px, 100%);
    max-height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    overflow-wrap: anywhere;
    padding: var(--sheet-pad);
    border-radius: 16px;
    background: var(--xlear-bg);
    color-scheme: var(--xlear-color-scheme);
    color: var(--xlear-text);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    box-sizing: border-box;
  }
  h1 { flex: none; margin: 0 0 16px; font-size: 20px; line-height: 24px; font-weight: 700; }
  .heading { flex: none; display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
  .heading h1 { flex: 1; min-width: 0; margin: 0; }
  .heading .reuse { flex: none; max-width: 45%; padding: 6px 10px; font-size: 13px; }
  /* 列表区：上下各一条贯通整宽的细分隔线（用负外边距抵消 sheet 的内边距），
     列表自身定高 + 内部滚动，滚动条隐藏。 */
  .lists-section {
    min-height: 48px;
    overflow-y: auto;
    overscroll-behavior: contain;
    margin: 0 calc(-1 * var(--sheet-pad)) 16px;
    padding: 0 var(--sheet-pad);
    border-top: 1px solid var(--xlear-border);
    border-bottom: 1px solid var(--xlear-border);
  }
  .lists-section > p.empty { margin: 0; padding: 14px 0; }
  ul.lists {
    list-style: none;
    margin: 0;
    padding: 12px 0;
    max-height: 240px;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: none;
  }
  ul.lists::-webkit-scrollbar { width: 0; height: 0; }
  ul.lists li + li { margin-top: 10px; }
  label.option { min-height: 44px; display: flex; gap: 10px; align-items: flex-start; cursor: pointer; font-size: 15px; }
  /* 圆形勾选：与扩展页面里的列表复选框同一套观感（那边是 .xl-list-row input[type="checkbox"]）。 */
  label.option input {
    appearance: none;
    flex: none;
    width: 20px;
    height: 20px;
    margin: 3px 0 0;
    border: 1.5px solid var(--xlear-border);
    border-radius: 50%;
    background: transparent;
    position: relative;
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease;
  }
  label.option:hover input:not(:checked) { border-color: var(--xlear-muted); }
  label.option input:checked { background: var(--xlear-accent); border-color: var(--xlear-accent); }
  label.option input::after {
    content: "";
    position: absolute;
    inset: 0;
    margin: auto;
    width: 12px;
    height: 12px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.6 6.0 L4.9 8.3 L9.4 3.2' fill='none' stroke='%23fff' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat;
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  label.option input:checked::after { opacity: 1; }
  .name { display: block; font-weight: 700; }
  .reason { display: block; margin-top: 2px; color: var(--xlear-muted); font-size: 13px; line-height: 18px; }
  /* 与 X 原生弹窗一致：两键之间 12px。 */
  .actions { flex: none; display: flex; flex-direction: column; gap: 12px; }
  /* 主操作占一行，取消单独一行，省纵向空间。 */
  .actions .row { display: flex; gap: 12px; }
  .actions .row > button { flex: 1 1 0; min-width: 0; }
  button {
    min-height: 44px;
    padding: 10px 14px;
    line-height: 18px;
    white-space: normal;
    border-radius: 9999px;
    border: 1px solid transparent;
    font-family: inherit;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    touch-action: manipulation;
  }
  :focus-visible { outline: 2px solid var(--xlear-accent); outline-offset: 2px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .primary { background: var(--xlear-danger); color: #ffffff; }
  /* 非破坏性动作（例如「不再隐藏」）用品牌色，不借用表示屏蔽的红色。 */
  .accent { background: var(--xlear-accent); color: #ffffff; }
  .primary:not(:disabled):hover { filter: brightness(1.1); }
  .accent:not(:disabled):hover { filter: brightness(1.1); }
  .ghost { background: transparent; border-color: var(--xlear-border); color: var(--xlear-text); }
  .ghost:not(:disabled):hover { background: var(--xlear-panel); }
`;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { class?: string; text?: string; attrs?: Record<string, string> } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  return node;
}

/** 组装弹窗内容。返回已完成交互绑定的根节点。 */
function buildSheet(
  options: DialogOptions,
  outcome: (result: DialogResult) => void,
): { backdrop: HTMLElement; focusTarget: HTMLElement | null } {
  const selected = new Set<string>();
  const { lists, previousIds } = recentReasonLists(
    options.lists,
    options.history,
  );
  const checkboxes = new Map<string, HTMLInputElement>();
  const strings = options.strings;
  const backdrop = element("div", { class: "backdrop" });
  backdrop.addEventListener("click", () => outcome({ kind: "cancel" }));

  const sheet = element("div", {
    class: "sheet",
    attrs: {
      role: "dialog",
      "aria-modal": "true",
      "aria-label": strings.ariaLabel,
    },
  });
  sheet.addEventListener("click", (event) => event.stopPropagation());

  const heading = element("div", { class: "heading" });
  heading.append(
    element("h1", {
      text: strings.title.replaceAll("{user}", options.screenName ?? "?"),
    }),
  );
  sheet.append(heading);

  const confirmButton = element("button", {
    class: "primary",
    text: strings.confirm,
    attrs: { type: "button", disabled: "true" },
  });
  confirmButton.addEventListener("click", () => {
    confirmButton.disabled = true;
    confirmButton.textContent = strings.processing;
    outcome({ kind: "confirm", listIds: [...selected] });
  });

  // 调用方保证至少有一条名单：一条都没有时不该抢 X 自己的屏蔽流程（见 blockmenu）。
  const listsSection = element("div", { class: "lists-section" });
  const list = element("ul", { class: "lists" });
  for (const item of lists) {
    const checkbox = element("input", { attrs: { type: "checkbox" } });
    checkboxes.set(item.id, checkbox);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(item.id);
      else selected.delete(item.id);
      confirmButton.disabled = selected.size === 0;
    });
    const label = element("label", { class: "option" });
    const text = element("span");
    text.append(
      element("span", { class: "name", text: item.name }),
      element("span", { class: "reason", text: item.reason }),
    );
    label.append(checkbox, text);
    const row = element("li");
    row.append(label);
    list.append(row);
  }
  listsSection.append(list);
  sheet.append(listsSection);

  if (previousIds.length > 0) {
    const names = lists.filter((item) => previousIds.includes(item.id)).map((
      item,
    ) => item.name);
    const hint = strings.reusePreviousHint.replaceAll(
      "{lists}",
      names.join(" / "),
    );
    const reuse = element("button", {
      class: "ghost reuse",
      text: strings.reusePrevious,
      attrs: { type: "button", title: hint, "aria-label": hint },
    });
    reuse.addEventListener("click", () => {
      selected.clear();
      for (const [id, checkbox] of checkboxes) {
        checkbox.checked = previousIds.includes(id);
        if (checkbox.checked) selected.add(id);
      }
      confirmButton.disabled = selected.size === 0;
    });
    heading.append(reuse);
  }

  const actions = element("div", { class: "actions" });
  const cancel = element("button", {
    class: "ghost",
    text: strings.cancel,
    attrs: { type: "button" },
  });
  cancel.addEventListener("click", () => outcome({ kind: "cancel" }));
  const row = element("div", { class: "row" });
  row.append(confirmButton);
  actions.append(row, cancel);
  sheet.append(actions);

  backdrop.append(sheet);
  return { backdrop, focusTarget: list.querySelector("input") ?? cancel };
}

export interface ConfirmOptions {
  screenName?: string;
  strings: {
    /** 含 {user} 占位符。 */
    title: string;
    ariaLabel: string;
    confirm: string;
    cancel: string;
  };
}

/** 组装确认弹窗（标题 + 主按钮 + 取消），与理由弹窗同一套外壳与按钮写法。 */
function buildConfirmSheet(
  options: ConfirmOptions,
  settle: (confirmed: boolean) => void,
): { backdrop: HTMLElement; focusTarget: HTMLElement | null } {
  const strings = options.strings;
  const user = options.screenName ?? "?";
  const backdrop = element("div", { class: "backdrop" });
  backdrop.addEventListener("click", () => settle(false));

  const sheet = element("div", {
    class: "sheet",
    attrs: {
      role: "dialog",
      "aria-modal": "true",
      "aria-label": strings.ariaLabel.replaceAll("{user}", user),
    },
  });
  sheet.addEventListener("click", (event) => event.stopPropagation());
  sheet.append(
    element("h1", { text: strings.title.replaceAll("{user}", user) }),
  );

  const confirm = element("button", {
    class: "accent",
    text: strings.confirm,
    attrs: { type: "button" },
  });
  confirm.addEventListener("click", () => settle(true));
  const cancel = element("button", {
    class: "ghost",
    text: strings.cancel,
    attrs: { type: "button" },
  });
  cancel.addEventListener("click", () => settle(false));

  const actions = element("div", { class: "actions" });
  const row = element("div", { class: "row" });
  row.append(confirm);
  actions.append(row, cancel);
  sheet.append(actions);

  backdrop.append(sheet);
  return { backdrop, focusTarget: confirm };
}

/** 打开确认弹窗，返回用户是否确认。 */
export function showConfirmDialog(options: ConfirmOptions): Promise<boolean> {
  return openDialog((settle) => buildConfirmSheet(options, settle), false);
}

/**
 * 挂载外壳：Shadow DOM 宿主 + 遮罩 + Esc 处理。
 *
 * @param build 组装内容（aria-label 由各自的 sheet 元素承载）；用 `settle` 结束这次交互。
 * @param cancelValue Esc 或点遮罩时返回的值。
 */
function openDialog<T>(
  build: (
    settle: (value: T) => void,
  ) => { backdrop: HTMLElement; focusTarget: HTMLElement | null },
  cancelValue: T,
): Promise<T> {
  if (isReasonDialogOpen()) return Promise.resolve(cancelValue);
  return new Promise<T>((resolve) => {
    const previous = document.activeElement;
    const unlockScroll = lockPageScroll();
    const inert = new Map<Element, boolean>();
    let settled = false;
    const settle = (value: T) => {
      if (settled) return;
      settled = true;
      cancelActive = undefined;
      document.removeEventListener("keydown", onKey, true);
      window.visualViewport?.removeEventListener("resize", layout);
      window.visualViewport?.removeEventListener("scroll", layout);
      window.removeEventListener("resize", layout);
      window.removeEventListener("pagehide", cancel);
      stopTheme();
      host.remove();
      for (const [node, old] of inert) node.toggleAttribute("inert", old);
      unlockScroll();
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
      resolve(value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        settle(cancelValue);
      } else if (event.key === "Tab") {
        const focusable = [
          ...shadow.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
          ),
        ];
        if (!focusable.length) return;
        const index = focusable.indexOf(shadow.activeElement as HTMLElement);
        const next = event.shiftKey
          ? (index <= 0 ? focusable.length - 1 : index - 1)
          : (index + 1) % focusable.length;
        event.preventDefault();
        event.stopImmediatePropagation();
        focusable[next]?.focus();
      }
    };

    // 挂在 body 而不是 #layers：#layers 在自动执行时会被整体隐藏，
    // 我们的弹窗必须留在隐藏范围之外。
    const host = document.createElement("div");
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: "open" });
    const style = element("style");
    const stopTheme = observeTheme((theme) => {
      style.textContent = `:host { ${themeVariables(theme)} }${DIALOG_CSS}`;
    });
    shadow.append(style);
    document.body.append(host);
    document.addEventListener("keydown", onKey, true);

    const { backdrop, focusTarget } = build(settle);
    shadow.append(backdrop);
    for (const child of document.body.children) {
      if (child === host) continue;
      inert.set(child, child.hasAttribute("inert"));
      child.setAttribute("inert", "");
    }
    // 手机地址栏、软键盘与缩放改变的是可视视口，按钮始终留在可操作区域。
    const layout = () => {
      const viewport = window.visualViewport;
      backdrop.style.left = `${viewport?.offsetLeft ?? 0}px`;
      backdrop.style.top = `${viewport?.offsetTop ?? 0}px`;
      backdrop.style.width = `${viewport?.width ?? innerWidth}px`;
      backdrop.style.height = `${viewport?.height ?? innerHeight}px`;
    };
    const cancel = () => settle(cancelValue);
    cancelActive = cancel;
    window.visualViewport?.addEventListener("resize", layout);
    window.visualViewport?.addEventListener("scroll", layout);
    window.addEventListener("resize", layout);
    window.addEventListener("pagehide", cancel, { once: true });
    layout();
    focusTarget?.focus({ preventScroll: true });
  });
}

/** 打开理由弹窗，返回用户的选择。 */
export function showReasonDialog(
  options: DialogOptions,
): Promise<DialogResult> {
  return openDialog<DialogResult>(
    (settle) => buildSheet(options, settle),
    { kind: "cancel" },
  );
}

/** 是否已经有一个弹窗打开着。 */
export function isReasonDialogOpen(): boolean {
  return document.getElementById(HOST_ID) !== null;
}
