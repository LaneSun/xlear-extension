/**
 * 过滤引擎（ISOLATED world）：命中就隐藏，只隐藏。
 *
 * 帖子出现 → 作者命中本地过滤库 → 立刻隐藏并插入占位卡片（卡片上有"显示""不再隐藏""在 X 上屏蔽"）。
 * 不代用户操作 X：屏蔽只由用户点卡片按钮或 X 自己的菜单发起。
 *
 * 防闪烁：document_start 注入规则，把"尚未判定"的帖子设为不可见；判定完（命中或放行）
 * 打上 `decided` 才恢复可见。看门狗兜底——万一始终没有任何判定，撤掉规则，不让页面空白。
 */
import { showConfirmDialog } from "./dialog.ts";
import { X_FONT_STACK } from "./theme.ts";
import { ATTR, cellOf, SEL } from "./selectors.ts";

/**
 * 命中账号所在**格子**上的标记，值是账号 ID。
 *
 * X 会反复重建格子的内容（广告尤其频繁：实测每 ~83ms 重建一次），但**格子元素本身是复用的**。
 * 只在 article 上打标记的话，新建出来的 article 在扫描器补标记之前会完整可见一帧 —— 尺寸从
 * 占位卡片的高度跳到帖子本身的高度，就是肉眼看到的闪烁。把标记打在格子上并交给 CSS，
 * 重建出来的内容会被同步隐藏，不再有可见窗口。值存账号 ID 是为了让复用的格子能被识别出来。
 */
/** 收起后的高度：占位信息那一行的高度。JS 与 CSS 共用同一个值。 */
const HIDDEN_HEIGHT_PX = 52;

const CELL_HIDDEN_ATTR = "data-xlear-cell-hidden";



const STYLE_ID = "xlear-style";
const CLASS_PLACEHOLDER = "xlear-placeholder";
const WATCHDOG_MS = 5_000;

export interface MatchInfo {
  lists: string[];
}

export interface FilterDeps {
  /** 批量判断账号是否命中过滤库。 */
  match: (userIds: string[]) => Promise<Map<string, MatchInfo>>;
  /** 用户选择「不再隐藏」：写入允许列表（带上 @handle，列表页才看得懂）。 */
  allow: (userId: string, screenName?: string) => Promise<void>;
  /** 上报隐藏数量。 */
  countHidden: (userIds: readonly string[]) => void;
  /**
   * 替用户在 X 上屏蔽该账号：由内容脚本驱动 X 自己的菜单与确认按钮。
   * 返回给用户看的失败原因（成功返回 null，后续流程由屏蔽拦截器接管）。
   */
  blockOnX: (article: Element) => Promise<string | null>;
  /** 列表 ID -> 显示名，用于卡片文案。 */
  listName: (listId: string) => string;
  /** 已翻译的卡片文案。每次渲染时求值：语言可能在本页面存活期间被改掉。 */
  strings: () => {
    /** 含 {user} 与 {lists} 占位符。 */
    text: string;
    /** 含 {lists} 占位符（没有用户名时使用）。 */
    textNoHandle: string;
    show: string;
    neverHide: string;
    /** 含 {user} 占位符，用在确认弹窗的标题上。 */
    neverHideConfirm: string;
    /** 确认弹窗的主按钮文字（与卡片按钮同一句）。 */
    neverHideConfirmAction: string;
    /** 确认弹窗的取消按钮。 */
    cancel: string;
    block: string;
    listSeparator: string;
  };
}

export interface FilterHandle {
  /** 重新分类所有帖子（订阅变化或同步完成后调用）。 */
  refresh: () => void;
  /** 命中缓存的账号集合。 */
  matched: () => Map<string, MatchInfo>;
}

function ensureStyle(placeholderCss: string): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /*
     * 隐藏 = 压缩高度 + 实心遮罩，**不改 display**。
     *
     * 为什么不直接 display:none：X 会反复重建时间线节点（广告位实测每 ~83ms 一次）。
     * 把元素从布局里抽走，会让 X 的虚拟化与测量看到"内容消失"，从而更频繁地重建；
     * 保留布局盒、只把它压矮，X 侧看到的只是"这条帖子变短了"，渲染流程不受干预。
     * 规则挂在**格子**上：格子元素在多次重建之间是复用的，所以新渲染出来的内容会自动
     * 落进同一条规则，不需要 JS 抢时间。
     */
    [${CELL_HIDDEN_ATTR}] article[data-testid="tweet"] {
      position: relative;
      overflow: hidden;
      height: ${HIDDEN_HEIGHT_PX}px !important;
    }
    /* 只在首次应用时过渡；重建出来的节点直接落位，避免动画一直重播。 */
    [${CELL_HIDDEN_ATTR}] article.xlear-collapsing { transition: height 180ms ease; }
    /* 遮罩：绝对定位铺满整条帖子，实心背景挡住内容，自己接收点击（底下的内容点不到）。 */
    [data-xlear-overlay] {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      background: Canvas;
      z-index: 1;
      opacity: 1;
      transition: opacity 180ms ease;
    }
    /* 首次应用：遮罩从透明淡入，避免硬闪。 */
    [data-xlear-overlay][data-xlear-enter] { opacity: 0; }
    /* 自动执行屏蔽时，把 X 的菜单与确认弹窗藏起来，用户看不到闪动。 */
    #layers.xlear-suppress > * { visibility: hidden !important; }
    ${placeholderCss}
  `;
  // 脚本在 document_start 运行，此时 <head> 可能还不存在；挂到 <html> 上同样生效。
  (document.head ?? document.documentElement).append(style);
}

function removeHideRule(): void {
  const style = document.getElementById(STYLE_ID);
  if (!style?.textContent) return;
  style.textContent = style.textContent.replace(
    `article[data-testid="tweet"]:not([${ATTR.decided}]) { visibility: hidden !important; }`,
    "",
  );
}

const PLACEHOLDER_CSS = `
  .${CLASS_PLACEHOLDER} {
    display: flex;
    align-items: center;
    gap: 8px;
    /* 不要自带下边框：格子本身已有分隔线，多这一条会看出一条"多余的下边框线"。 */
    padding: 12px 16px;
    width: 100%;
    color: var(--xlear-muted, #71767b);
    /* 这里必须写具体字体栈：--xlear-font 只定义在弹窗的 shadow 宿主上，页面 DOM 里取不到，
       回退成 inherit 会落到系统默认字体，与 X 的正文明显不同。
       字号与行高对齐 X 的正文（15px/20px）。 */
    font-family: ${X_FONT_STACK};
    font-size: 15px;
    line-height: 20px;
  }
  .${CLASS_PLACEHOLDER} .xlear-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .${CLASS_PLACEHOLDER} button {
    flex: none;
    background: transparent;
    border: none;
    color: var(--xlear-accent, #1d9bf0);
    font: inherit;
    font-weight: 700;
    cursor: pointer;
    padding: 2px 4px;
  }
  .${CLASS_PLACEHOLDER} button:hover { text-decoration: underline; }
  /* 「在 X 上屏蔽」固定在最右侧，与"显示顺序"无关。 */
  .${CLASS_PLACEHOLDER} .xlear-block { margin-left: auto; }
`;

/** 在卡片上写一条提示（提交失败、屏蔽入口打不开等需要用户知道的状况）。 */

/** 撤销隐藏：去掉高度压缩、遮罩与辅助技术上的隐藏标记，恢复成普通帖子。 */
function releaseArticleDom(article: Element): void {
  const node = article as HTMLElement;
  const overlay = article.querySelector<HTMLElement>("[data-xlear-overlay]");
  const cell = cellOf(article);
  const height = node.getBoundingClientRect().height;
  const collapsed = cell?.hasAttribute(CELL_HIDDEN_ATTR) === true &&
    height > 0 && height <= HIDDEN_HEIGHT_PX + 8;

  const finish = () => {
    overlay?.remove();
    article.classList.remove("xlear-collapsing");
    node.style.removeProperty("height");
    for (const child of [...article.children]) child.removeAttribute("aria-hidden");
  };

  if (!collapsed) {
    // 本来就没收起（或已经放行过）：直接恢复，不做动画。
    finish();
    cell?.removeAttribute(CELL_HIDDEN_ATTR);
    return;
  }

  // 与收起对称：先用当前高度顶住，再交回自然高度，让高度与遮罩一起过渡。
  node.style.setProperty("height", `${Math.round(height)}px`, "important");
  article.classList.add("xlear-collapsing");
  overlay?.setAttribute("data-xlear-enter", "");
  requestAnimationFrame(() => {
    cell!.removeAttribute(CELL_HIDDEN_ATTR);
    node.style.removeProperty("height");
    article.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 400);
  });
}


function buildPlaceholder(
  deps: FilterDeps,
  info: MatchInfo,
  userId: string,
  screenName: string | undefined,
  article: Element,
): HTMLElement {
  const card = document.createElement("div");
  card.className = CLASS_PLACEHOLDER;
  card.setAttribute("data-xlear-card", userId);

  const strings = deps.strings();

  const text = document.createElement("span");
  text.className = "xlear-text";
  const listNames = info.lists.map((id) => deps.listName(id)).join(strings.listSeparator);
  const template = screenName ? strings.text : strings.textNoHandle;
  text.textContent = template
    .replaceAll("{user}", screenName ?? "")
    .replaceAll("{lists}", listNames);

  const showButton = document.createElement("button");
  showButton.type = "button";
  showButton.textContent = strings.show;
  showButton.addEventListener("click", (event) => {
    event.stopPropagation();
    article.removeAttribute(ATTR.filtered);
    card.remove();
    // 只影响这一条，不写入允许列表。
    article.setAttribute("data-xlear-shown", "1");
    // 用户自己选了显示：撤销压缩与遮罩，否则新渲染的内容会继续被挡住。
    releaseArticleDom(article);
  });

  const allowButton = document.createElement("button");
  allowButton.type = "button";
  allowButton.textContent = strings.neverHide;
  allowButton.addEventListener("click", (event) => {
    event.stopPropagation();
    // 「不再隐藏」会改变这个账号在此后的表现，先确认一次（样式与理由弹窗一致）。
    allowButton.disabled = true;
    void showConfirmDialog({
      screenName,
      strings: {
        title: strings.neverHideConfirm,
        ariaLabel: strings.neverHideConfirm,
        confirm: strings.neverHideConfirmAction,
        cancel: strings.cancel,
      },
    }).then((confirmed) => {
      allowButton.disabled = false;
      if (!confirmed) return;
      return deps.allow(userId, screenName).then(() => {
        article.removeAttribute(ATTR.filtered);
        card.remove();
        releaseArticleDom(article);
      });
    });
  });

  const blockButton = document.createElement("button");
  blockButton.type = "button";
  blockButton.className = "xlear-block";
  blockButton.textContent = strings.block;
  blockButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const label = blockButton.textContent ?? "";
    blockButton.disabled = true;
    void deps.blockOnX(article).then(() => {
      blockButton.disabled = false;
      blockButton.textContent = label;
    });
  });

  card.append(text, showButton, allowButton, blockButton);
  return card;
}

export function installFilter(deps: FilterDeps): FilterHandle {
  ensureStyle(PLACEHOLDER_CSS);

  const matched = new Map<string, MatchInfo>();
  const pendingUsers = new Set<string>();
  let scheduled = false;
  let sawDecided = false;

  const watchdog = setTimeout(() => {
    if (!sawDecided) {
      // 扫描或判定没能在预期时间内工作，先撤掉隐藏规则，绝不让页面保持空白。
      removeHideRule();
    }
  }, WATCHDOG_MS);
  addEventListener("pagehide", () => clearTimeout(watchdog), { once: true });

  /** 本批被隐藏的账号（同一账号多条帖子只算一次）。 */
  const hiddenUsers = new Set<string>();

  const releaseArticle = (article: Element) => releaseArticleDom(article);

  const hideArticle = (article: Element, info: MatchInfo) => {
    article.setAttribute(ATTR.decided, "1");
    const userId = article.getAttribute(ATTR.user) ?? "";
    const screenName = article.getAttribute(ATTR.name) ?? undefined;
    const node = article as HTMLElement;
    const cell = cellOf(article);

    // 格子已经标记过（X 重建出来的节点）→ 直接落位，不重播动画。
    const cellMarked = !!cell?.hasAttribute(CELL_HIDDEN_ATTR);
    if (!cellMarked) {
      // 起点也要 !important：否则 CSS 的目标高度会立刻压过内联起点，看上去就是"闪一下就收起"。
      node.style.setProperty("height", `${Math.round(article.getBoundingClientRect().height)}px`, "important");
      article.classList.add("xlear-collapsing");
      requestAnimationFrame(() => {
        node.style.setProperty("height", `${HIDDEN_HEIGHT_PX}px`, "important");
        // 与高度同时开始：遮罩淡入，原来的内容被逐渐盖住。
        article.querySelector("[data-xlear-overlay][data-xlear-enter]")?.removeAttribute("data-xlear-enter");
        const finish = () => {
          node.style.removeProperty("height");
          article.classList.remove("xlear-collapsing");
        };
        article.addEventListener("transitionend", finish, { once: true });
        // 过渡被打断（节点被换掉）时的兜底，避免 class 长期挂在身上。
        setTimeout(finish, 400);
      });
    }
    article.setAttribute(ATTR.filtered, "hidden");

    if (cell) {
      cell.setAttribute(CELL_HIDDEN_ATTR, userId);
      if (!article.querySelector("[data-xlear-overlay]")) {
        const overlay = document.createElement("div");
        overlay.setAttribute("data-xlear-overlay", "");
        if (!cellMarked) overlay.setAttribute("data-xlear-enter", "");
        overlay.append(buildPlaceholder(deps, info, userId, screenName, article));
        article.append(overlay);
        // 原内容对辅助技术隐藏（视觉上本来就被遮罩盖住），遮罩里的文案照常可读。
        for (const child of [...article.children]) {
          if (child !== overlay) child.setAttribute("aria-hidden", "true");
        }
      }
    }
    hiddenUsers.add(userId);
  };

  /**
   * 恢复显示：账号不再命中（退订、关掉总开关、移除本地覆盖）时把帖子放回去。
   * 用户自己点过"显示"或"仍然显示"的帖子不在命中缓存里，本来就不会被隐藏。
   */
  const unhideArticle = (article: Element) => {
    article.setAttribute(ATTR.decided, "1");
    if (article.getAttribute(ATTR.filtered) !== "hidden") return;
    article.removeAttribute(ATTR.filtered);
    releaseArticle(article);
  };

  const classify = () => {
    scheduled = false;
    if (pendingUsers.size === 0) return;
    const users = [...pendingUsers];
    pendingUsers.clear();
    void deps.match(users).then((matches) => {
      for (const [userId, info] of matches) matched.set(userId, info);
      // 只处理**本批次问过**的账号：matches 是这一批的结果，不含其它账号。
      // 之前直接用它判断"未命中"，会把批次之外的帖子（详情页主体帖）误放行 ——
      // 评论区每渲染一条新回复就触发一次分类，于是主体帖被反复放行又隐藏，看起来就是闪烁。
      const asked = new Set(users);
      for (const article of document.querySelectorAll(`${SEL.tweet}[${ATTR.checked}]`)) {
        const userId = article.getAttribute(ATTR.user);
        if (!userId || !asked.has(userId)) continue;
        const info = matches.get(userId);
        if (!info) {
          unhideArticle(article);
        } else if (article.getAttribute("data-xlear-shown") !== "1") {
          hideArticle(article, info);
        } else {
          // 用户自己选择显示过这条：判定同样算完成，别再让它被防闪规则挡住。
          article.setAttribute(ATTR.decided, "1");
        }
      }
      if (hiddenUsers.size > 0) {
        deps.countHidden([...hiddenUsers]);
        hiddenUsers.clear();
      }
    }).catch(() => {
      // 后台暂时不可用（service worker 刚被唤醒等）。
      // 这里**不**立刻撤掉隐藏规则：那些帖子确实在本地过滤库里，先保持隐藏更符合预期，
      // 而立刻放行会让它们可见约一秒再被隐藏。
      // 恢复由两件事保证：下一次扫描会重试；看门狗在"始终没有任何判定"时兜底撤规则，
      // 所以最坏情况也不会把页面永久留白。
      const gate = Promise.withResolvers<void>();
      setTimeout(gate.resolve, 700);
      void gate.promise.then(() => {
        for (const article of document.querySelectorAll(`${SEL.tweet}[${ATTR.checked}]`)) {
          pendingUsers.add(article.getAttribute(ATTR.user) ?? "");
        }
        pendingUsers.delete("");
        if (pendingUsers.size > 0 && !scheduled) {
          scheduled = true;
          setTimeout(classify, 50);
        }
      });
    });
  };

  const collect = (article: Element) => {
    if (article.hasAttribute(ATTR.decided)) sawDecided = true;
    const userId = article.getAttribute(ATTR.user);
    if (!userId) {
      // 取不到作者的帖子（广告位、布局变化）没有"命中"可言：直接视为已判定，
      // 否则防闪规则会让它永远不可见。
      article.setAttribute(ATTR.decided, "1");
      return;
    }
    // 节点被复用后，单元格里可能还留着上一条帖子的占位卡片。
    const cell = cellOf(article);
    if (cell) {
      for (const card of cell.querySelectorAll("[data-xlear-card]")) {
        if (card.getAttribute("data-xlear-card") !== userId) card.remove();
      }
      // 格子被复用给别的账号时，旧标记必须清掉，否则会误伤新内容。
      const marked = cell.getAttribute(CELL_HIDDEN_ATTR);
      // 一个格子可能同时装着不止一条帖子（广告位就是：广告 + 另一条普通帖）。
      // 只有确认格子里**不再有**那个被隐藏账号的帖子时，才按"格子被复用"处理 ——
      // 否则会被同格里另一条帖子的收集动作误判，把隐藏状态撤销掉。
      const stillHidden = marked
        ? cell.querySelector(`article[data-xlear-user="${CSS.escape(marked)}"][${ATTR.filtered}="hidden"]`)
        : null;
      if (marked && marked !== userId && !stillHidden) {
        cell.removeAttribute(CELL_HIDDEN_ATTR);
        for (const article of cell.querySelectorAll('article[data-testid="tweet"]')) {
          releaseArticle(article);
        }
      }
    }
    const cached = matched.get(userId);
    if (cached) {
      if (article.getAttribute("data-xlear-shown") !== "1") hideArticle(article, cached);
      else article.setAttribute(ATTR.decided, "1");
      return;
    }
    pendingUsers.add(userId);
    if (!scheduled) {
      scheduled = true;
      setTimeout(classify, 50);
    }
  };

  const scan = () => {
    for (const article of document.querySelectorAll(SEL.tweet)) collect(article);
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(SEL.tweet)) collect(node);
        for (const nested of node.querySelectorAll(SEL.tweet)) collect(nested);
      }
      // React 重渲染可能覆盖属性，节点被改动时重新检查一次。
      if (mutation.type === "attributes" && mutation.target instanceof Element) {
        collect(mutation.target);
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [ATTR.user, ATTR.tweet, ATTR.checked],
  });

  setInterval(scan, 3_000);
  scan();

  return {
    refresh: () => {
      matched.clear();
      scan();
    },
    matched: () => matched,
  };
}
