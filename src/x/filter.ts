/** 过滤引擎：压缩帖子并覆盖原内容，保留 X 的虚拟列表与用户发起的操作。 */
import { showConfirmDialog } from "./dialog.ts";
import { readTheme, themeVariables, X_FONT_STACK } from "./theme.ts";
import { ATTR, cellOf, SEL } from "./selectors.ts";

const STYLE_ID = "xlear-style";
const CELL_HIDDEN_ATTR = "data-xlear-cell-hidden";
const HEIGHT = "--xlear-height";
const CACHE_LIMIT = 2_000;
const WATCHDOG_MS = 2_000;

export interface MatchInfo {
  lists: string[];
}
export interface FilterDeps {
  match: (userIds: string[]) => Promise<Map<string, MatchInfo>>;
  allow: (userId: string, screenName?: string) => Promise<void>;
  countHidden: (userIds: readonly string[]) => void;
  blockOnX: (article: Element) => Promise<string | null>;
  listName: (listId: string) => string;
  strings: () => {
    text: string;
    textNoHandle: string;
    show: string;
    neverHide: string;
    neverHideConfirm: string;
    neverHideConfirmAction: string;
    cancel: string;
    block: string;
    listSeparator: string;
  };
}
export interface FilterHandle {
  refresh: () => void;
  matched: () => Map<string, MatchInfo>;
  destroy: () => void;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    ${SEL.tweet}:not([${ATTR.decided}]) { visibility: hidden !important; }
    /* 格子重建期间先保留高度；已识别的同格其他帖子不受这个规则影响。 */
    [${CELL_HIDDEN_ATTR}] ${SEL.tweet}:not([${ATTR.decided}]),
    ${SEL.tweet}[${ATTR.filtered}="hidden"] {
      position: relative !important;
      overflow: hidden !important;
      box-sizing: border-box !important;
      min-height: 0 !important;
      height: var(${HEIGHT}, 100px) !important;
      max-height: none !important;
    }
    /* 移动 X 的头像/媒体带独立 z-index；整个原始子树透明，避免穿透遮罩。 */
    ${SEL.tweet}[${ATTR.filtered}="hidden"] > :not([data-xlear-overlay]) {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    [data-xlear-overlay] {
      position: absolute; inset: 0; z-index: 1;
      background: var(--xlear-bg, Canvas); color: var(--xlear-muted);
    }
    .xlear-placeholder {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0 8px;
      box-sizing: border-box; width: 100%; padding: 4px 12px;
      font: 15px/20px ${X_FONT_STACK};
    }
    .xlear-placeholder .xlear-text {
      flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; padding: 8px 0;
    }
    .xlear-placeholder .xlear-actions { display: flex; flex-wrap: wrap; gap: 0 8px; }
    .xlear-placeholder button {
      min-height: 44px; max-width: 100%; padding: 8px 4px; border: 0; border-radius: 8px;
      background: transparent; color: var(--xlear-accent, #1d9bf0);
      font: inherit; font-weight: 700; cursor: pointer; touch-action: manipulation;
      overflow-wrap: anywhere;
    }
    .xlear-placeholder button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
    .xlear-placeholder button:disabled { opacity: .5; cursor: wait; }
    .xlear-placeholder .xlear-error { flex-basis: 100%; color: var(--xlear-danger); overflow-wrap: anywhere; }
    @media (max-width: 600px) {
      .xlear-placeholder .xlear-text { flex-basis: 100%; }
      .xlear-placeholder .xlear-actions { width: 100%; justify-content: space-between; }
    }
    #layers.xlear-suppress > * { visibility: hidden !important; }
  `;
  (document.head ?? document.documentElement).append(style);
}

interface HiddenState {
  identity: string | null;
  signature: string;
  overlay: HTMLElement;
  card: HTMLElement;
  cell: HTMLElement | null;
  children: Map<Element, { aria: string | null; inert: boolean }>;
}

export function installFilter(deps: FilterDeps): FilterHandle {
  ensureStyle();
  const cache = new Map<string, MatchInfo | null>();
  const hidden = new Map<Element, HiddenState>();
  const pending = new Set<string>();
  const inFlight = new Set<string>();
  const undecided = new Map<Element, number>();
  const counted = new Set<string>();
  let generation = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const release = (article: Element) => {
    const state = hidden.get(article);
    if (state) {
      resize.unobserve(state.card);
      state.overlay.remove();
      for (const [child, old] of state.children) {
        if (old.aria === null) child.removeAttribute("aria-hidden");
        else child.setAttribute("aria-hidden", old.aria);
        child.toggleAttribute("inert", old.inert);
      }
      if (
        state.cell?.getAttribute(CELL_HIDDEN_ATTR) ===
          article.getAttribute(ATTR.user) ||
        state.cell?.querySelectorAll(SEL.tweet).length === 1
      ) {
        state.cell.removeAttribute(CELL_HIDDEN_ATTR);
        state.cell.style.removeProperty(HEIGHT);
      }
      hidden.delete(article);
    }
    article.removeAttribute(ATTR.filtered);
    (article as HTMLElement).style.removeProperty(HEIGHT);
  };

  const measure = (article: Element, state: HiddenState) => {
    if (!article.isConnected) return;
    const height = `${Math.ceil(state.card.getBoundingClientRect().height)}px`;
    const node = article as HTMLElement;
    if (node.style.getPropertyValue(HEIGHT) !== height) {
      node.style.setProperty(HEIGHT, height);
    }
    if (state.cell?.getAttribute(CELL_HIDDEN_ATTR)) {
      state.cell.style.setProperty(HEIGHT, height);
    }
  };
  const resize = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const article = entry.target.closest(SEL.tweet);
      const state = article ? hidden.get(article) : undefined;
      if (article && state) measure(article, state);
    }
  });

  const hide = (article: Element, info: MatchInfo) => {
    const userId = article.getAttribute(ATTR.user)!;
    const screenName = article.getAttribute(ATTR.name) ?? undefined;
    const strings = deps.strings();
    const names = info.lists.map(deps.listName).join(strings.listSeparator);
    const canBlock = article.querySelector(SEL.caret) !== null;
    const signature = JSON.stringify([
      article.getAttribute(ATTR.identity),
      names,
      strings,
      canBlock,
    ]);
    let state = hidden.get(article);
    if (
      state &&
      (state.signature !== signature || !article.contains(state.overlay))
    ) {
      release(article);
      state = undefined;
    }
    if (!state) {
      const overlay = document.createElement("div");
      overlay.setAttribute("data-xlear-overlay", "");
      const card = document.createElement("div");
      card.className = "xlear-placeholder";
      card.setAttribute("data-xlear-card", userId);
      const label = document.createElement("span");
      label.className = "xlear-text";
      label.textContent = (screenName ? strings.text : strings.textNoHandle)
        .replaceAll("{user}", screenName ?? "").replaceAll("{lists}", names);
      const actions = document.createElement("div");
      actions.className = "xlear-actions";
      const error = document.createElement("span");
      error.className = "xlear-error";
      error.setAttribute("role", "status");
      const current = () =>
        article.isConnected && hidden.get(article)?.overlay === overlay;
      const button = (label: string, action: () => Promise<void> | void) => {
        const node = document.createElement("button");
        node.type = "button";
        node.textContent = label;
        node.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!current()) return;
          node.disabled = true;
          error.textContent = "";
          void Promise.resolve().then(action).catch((reason: unknown) => {
            error.textContent = reason instanceof Error
              ? reason.message
              : String(reason);
          }).finally(() => {
            node.disabled = false;
          });
        });
        actions.append(node);
      };
      button(strings.show, () => {
        article.setAttribute("data-xlear-shown", "1");
        release(article);
      });
      button(strings.neverHide, async () => {
        const confirmed = await showConfirmDialog({
          screenName,
          strings: {
            title: strings.neverHideConfirm,
            ariaLabel: strings.neverHideConfirm,
            confirm: strings.neverHideConfirmAction,
            cancel: strings.cancel,
          },
        });
        if (!confirmed || !current()) return;
        await deps.allow(userId, screenName);
        generation++;
        inFlight.clear();
        pending.delete(userId);
        cache.set(userId, null);
        for (const tweet of document.querySelectorAll(SEL.tweet)) {
          if (tweet.getAttribute(ATTR.user) === userId) release(tweet);
        }
      });
      if (canBlock) {
        button(strings.block, async () => {
          const message = await deps.blockOnX(article);
          if (message) error.textContent = message;
        });
      }
      card.append(label, actions, error);
      overlay.append(card);
      // 点击占位卡片不应冒泡到 X 的整条帖子导航处理器。
      overlay.addEventListener("click", (event) => event.stopPropagation());
      article.append(overlay);
      state = {
        identity: article.getAttribute(ATTR.identity),
        signature,
        overlay,
        card,
        cell: cellOf(article),
        children: new Map(),
      };
      hidden.set(article, state);
      resize.observe(card);
    }
    state.overlay.style.cssText = themeVariables(readTheme());
    for (const child of article.children) {
      if (child === state.overlay || state.children.has(child)) continue;
      state.children.set(child, {
        aria: child.getAttribute("aria-hidden"),
        inert: child.hasAttribute("inert"),
      });
      child.setAttribute("aria-hidden", "true");
      child.setAttribute("inert", "");
    }
    // 只给独占格子留重建标记，不能连带收起同一格里的其他作者。
    if (state.cell?.querySelectorAll(SEL.tweet).length === 1) {
      state.cell.setAttribute(CELL_HIDDEN_ATTR, userId);
    } else if (state.cell) {
      state.cell.removeAttribute(CELL_HIDDEN_ATTR);
      state.cell.style.removeProperty(HEIGHT);
    }
    article.setAttribute(ATTR.filtered, "hidden");
    article.setAttribute(ATTR.decided, "1");
    measure(article, state);
    if (!counted.has(userId)) {
      counted.add(userId);
      deps.countHidden([userId]);
    }
  };

  const classify = async () => {
    timer = undefined;
    const users = [...pending];
    pending.clear();
    if (!users.length || stopped) return;
    const revision = generation;
    users.forEach((id) => inFlight.add(id));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const matches = await Promise.race([
        deps.match(users),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Match timeout")), 5_000);
        }),
      ]);
      if (stopped || revision !== generation) return;
      for (const id of users) cache.set(id, matches.get(id) ?? null);
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      const asked = new Set(users);
      document.querySelectorAll(SEL.tweet).forEach((tweet) => {
        if (asked.has(tweet.getAttribute(ATTR.user) ?? "")) collect(tweet);
      });
    } catch {
      // 看门狗放行未判定的帖子；周期扫描重试，已隐藏内容保持原状。
    } finally {
      clearTimeout(timeout);
      if (revision === generation) users.forEach((id) => inFlight.delete(id));
    }
  };

  const collect = (article: Element) => {
    if (stopped || !article.isConnected || !article.matches(SEL.tweet)) return;
    const state = hidden.get(article);
    if (state && state.identity !== article.getAttribute(ATTR.identity)) {
      release(article);
    }
    const cell = cellOf(article);
    const marked = cell?.getAttribute(CELL_HIDDEN_ATTR);
    if (
      marked &&
      ![...cell!.querySelectorAll(SEL.tweet)].some((tweet) =>
        tweet.getAttribute(ATTR.user) === marked &&
        tweet.getAttribute(ATTR.filtered) === "hidden"
      )
    ) {
      cell!.removeAttribute(CELL_HIDDEN_ATTR);
      cell!.style.removeProperty(HEIGHT);
    }
    const userId = article.getAttribute(ATTR.user);
    if (!article.hasAttribute(ATTR.checked)) {
      if (!undecided.has(article)) undecided.set(article, Date.now());
      return;
    }
    if (!userId || article.getAttribute("data-xlear-shown") === "1") {
      release(article);
      article.setAttribute(ATTR.decided, "1");
      undecided.delete(article);
      return;
    }
    if (cache.has(userId)) {
      const info = cache.get(userId);
      if (info) hide(article, info);
      else {
        release(article);
        article.setAttribute(ATTR.decided, "1");
      }
      undecided.delete(article);
    } else {
      if (!undecided.has(article)) undecided.set(article, Date.now());
      if (!inFlight.has(userId)) {
        pending.add(userId);
        timer ??= setTimeout(() => void classify(), 40);
      }
    }
  };
  const scan = () => {
    for (const article of hidden.keys()) {
      if (!article.isConnected) release(article);
    }
    if (!document.hidden) document.querySelectorAll(SEL.tweet).forEach(collect);
  };
  const observer = new MutationObserver((mutations) => {
    const dirty = new Set<Element>();
    for (const mutation of mutations) {
      const target = mutation.target instanceof Element
        ? mutation.target
        : null;
      if (target?.closest("[data-xlear-overlay]")) continue;
      const parent = target?.closest(SEL.tweet);
      if (parent) dirty.add(parent);
      for (const node of mutation.addedNodes) {
        if (
          !(node instanceof Element) || node.matches("[data-xlear-overlay]")
        ) continue;
        if (node.matches(SEL.tweet)) dirty.add(node);
        node.querySelectorAll(SEL.tweet).forEach((tweet) => dirty.add(tweet));
      }
    }
    dirty.forEach(collect);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      ATTR.identity,
      ATTR.user,
      ATTR.name,
      ATTR.tweet,
      ATTR.checked,
    ],
  });
  const watchdog = setInterval(() => {
    for (const [article, since] of undecided) {
      if (!article.isConnected || Date.now() - since >= WATCHDOG_MS) {
        article.setAttribute(ATTR.decided, "1");
        undecided.delete(article);
      }
    }
  }, 500);
  const interval = setInterval(scan, 3_000);
  document.addEventListener("visibilitychange", scan);
  scan();
  return {
    refresh: () => {
      generation++;
      cache.clear();
      pending.clear();
      inFlight.clear();
      scan();
    },
    matched: () =>
      new Map(
        [...cache].filter((entry): entry is [string, MatchInfo] =>
          entry[1] !== null
        ),
      ),
    destroy: () => {
      stopped = true;
      observer.disconnect();
      resize.disconnect();
      clearTimeout(timer);
      clearInterval(watchdog);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", scan);
      for (const article of hidden.keys()) release(article);
      document.getElementById(STYLE_ID)?.remove();
    },
  };
}
