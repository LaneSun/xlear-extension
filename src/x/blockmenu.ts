/**
 * 拦截 X 的「屏蔽」菜单项，插入理由选择步骤。
 *
 * 流程（不阻止 X 的行为，只把它藏起来再复用）：
 * 1. 捕获阶段记录用户点的是哪个帖子的更多菜单；
 * 2. 用户点「屏蔽」后 X 自己会打开确认弹窗，我们立刻把它隐藏；
 * 3. 显示自己的理由选择弹窗；
 * 4. 用户确认 → 取消隐藏 → 点 X 的确认按钮（X 发出真正的屏蔽请求）
 *    → 同时把这次动作提交到平台，并写入本地覆盖让效果立刻生效。
 */
import { t } from "../i18n.content.ts";
import { isReasonDialogOpen, showReasonDialog } from "./dialog.ts";
import {
  dismissMenu,
  simulateClick,
  suppressLayers,
  unsuppressLayers,
  waitFor,
} from "./executor.ts";
import { ATTR, SEL } from "./selectors.ts";

/** 等 X 的更多菜单出现的时间；超过就认为这条走不通。 */
const BLOCK_MENU_TIMEOUT_MS = 2_500;

export interface BlockMenuDeps {
  /**
   * 可以拿来当举报理由的名单：后台下发的已订阅服务器列表，加上已启用的本地列表。
   * 这里只要弹窗真正用到的三个字段，不必是完整的目录条目。
   */
  lists: () => { id: string; name: string; reason: string }[];
  /** 提交举报；返回给用户看的提示文案。 */
  submit: (
    target: { userId: string; screenName?: string },
    listIds: string[],
    tweet: { id: string; url?: string; text?: string },
  ) => Promise<string | null>;
  /** 本地覆盖：让这次提交立刻生效。 */
  addOverlay: (
    userId: string,
    screenName: string | undefined,
    listIds: string[],
  ) => Promise<void>;
  /** 把提交结果告知用户（失败时必须让用户看见，不能只进 console）。 */
  notify?: (userId: string, message: string) => void;
}

interface PendingTarget {
  userId: string;
  screenName?: string;
  tweetId: string;
  tweetUrl?: string;
  tweetText?: string;
}

/**
 * 卡片上的「在 X 上屏蔽」发起时置位：这一次的菜单点击直通 X。
 *
 * 该按钮的语义是"替用户点一下 X 原本的屏蔽入口"，所以要让 X 弹出**它自己**的确认弹窗，
 * 而不是插进我们的理由弹窗（那属于"用户自己在 X 上点屏蔽"的路径）。
 * 只在 `simulateClick` 那一瞬间为真：拦截器读到时立刻返回并复位。
 */
let passThroughToX = false;

export function installBlockMenuInterceptor(deps: BlockMenuDeps): void {
  // 记录最近一次点开的帖子，菜单本身不带作者信息，靠它关联。
  let lastArticle: Element | null = null;

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const caret = target.closest(SEL.caret);
    if (caret) {
      lastArticle = caret.closest(SEL.tweet);
      return;
    }

    // 菜单项：屏蔽有 testid，静音靠图标匹配。
    const menuItem = target.closest(SEL.menuItem);
    if (!menuItem) return;
    const isBlock = menuItem.matches(SEL.blockItem) ||
      menuItem.querySelector(SEL.blockItem) !== null;
    const isMute = !isBlock &&
      menuItem.querySelector("svg path")?.getAttribute("d")?.startsWith(
          "M16 22h-2.35",
        ) === true;
    if (!isBlock && !isMute) return;

    // 卡片按钮发起的原生屏蔽：交给 X 自己走它的确认弹窗，我们不插手。
    if (passThroughToX) return;

    const article = lastArticle ?? findArticleFromMenu(menuItem);
    if (!article) return;
    const pending = readPendingTarget(article);
    if (!pending) return;
    if (isReasonDialogOpen()) return;
    void handleInterceptedBlock(pending, deps);
  }, true);
}

/**
 * 替用户在 X 上屏蔽：点开这条帖子的更多菜单 → 点「屏蔽」→ 由 X 弹出它自己的确认弹窗。
 *
 * 这条路径**直通 X**（不插入理由弹窗、不提交平台举报）：按钮的语义就是"帮用户点一下 X 原本的屏蔽按钮"。
 * 想顺带提交到平台时，用户自己点 X 的「屏蔽」菜单项即可，那条路径仍会走理由弹窗。
 * 只模拟点击，写请求始终由 X 自己的前端发出；一次一条，失败就把原因交给卡片显示。
 */
export async function startBlockOnX(article: Element): Promise<string | null> {
  if (isReasonDialogOpen()) return null;
  const caret = article.querySelector<HTMLElement>(SEL.caret);
  if (!caret) return t("card.blockUnavailable");
  simulateClick(caret);
  const item = await waitFor(findBlockMenuItem, BLOCK_MENU_TIMEOUT_MS);
  if (!item) {
    // 菜单没出来：账号被平台限制、页面改版，或这条帖子已经不在时间线里。
    await dismissMenu();
    return t("card.blockUnavailable");
  }
  // 只在这一次派发期间置位：`simulateClick` 是同步派发，拦截器在同一次调用里就把标记读走了。
  passThroughToX = true;
  try {
    simulateClick(item);
  } finally {
    passThroughToX = false;
  }
  return null;
}

/** 菜单里的「屏蔽」项。静音项不认——按钮的语义就是在 X 上屏蔽。 */
function findBlockMenuItem(): HTMLElement | null {
  for (const item of document.querySelectorAll<HTMLElement>(SEL.menuItem)) {
    if (!item.closest(SEL.menu)) continue;
    if (item.matches(SEL.blockItem) || item.querySelector(SEL.blockItem)) {
      return item;
    }
  }
  return null;
}

/** 菜单是从 `#layers` 渲染的，取不到关联帖子时用属性反查。 */
function findArticleFromMenu(menuItem: Element): Element | null {
  const layers = menuItem.closest(SEL.layers);
  if (!layers) return null;
  // 菜单里通常带一个指向该用户的链接，用它反查帖子。
  const link = layers.querySelector('a[href^="/"]:not([href^="/i/"])');
  const handle = link?.getAttribute("href")?.split("/")[1];
  if (!handle) return null;
  return document.querySelector(
    `${SEL.tweet}[${ATTR.name}="${CSS.escape(handle)}"]`,
  );
}

function readPendingTarget(article: Element): PendingTarget | null {
  const userId = article.getAttribute(ATTR.user);
  if (!userId) return null;
  const screenName = article.getAttribute(ATTR.name) ?? undefined;
  const link = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
  const href = link?.getAttribute("href") ?? undefined;
  const tweetId = href?.match(/\/status\/(\d+)/)?.[1];
  if (!tweetId) return null;
  const text = article.querySelector(SEL.tweetText)?.textContent ?? undefined;
  return {
    userId,
    screenName,
    tweetId,
    tweetUrl: href ? new URL(href, location.origin).toString() : undefined,
    tweetText: text,
  };
}

async function handleInterceptedBlock(
  pending: PendingTarget,
  deps: BlockMenuDeps,
): Promise<void> {
  // X 已经在打开它自己的确认弹窗，先藏起来。
  // 一条能用的名单都没有时**不介入**：理由弹窗没有东西可选，插一脚只会挡住 X 自己的屏蔽流程。
  // 判断放在最前面 —— 此时还没藏 X 的弹窗，直接返回等于我们不存在。
  // 名单由调用方给定（已订阅的服务器列表 + 已启用的本地列表），这里再做一次防御性过滤。
  const available = deps.lists().filter((list) => list.id.length > 0);
  if (available.length === 0) return;

  suppressLayers();
  const dialogPresent = await waitFor(
    () => document.querySelector(SEL.dialog),
    2_000,
  );
  if (!dialogPresent) {
    // 没等到 X 的弹窗（例如它是直接屏蔽、无确认），此时不必插入我们的流程。
    unsuppressLayers();
    return;
  }

  const result = await showReasonDialog({
    screenName: pending.screenName,
    lists: available.map((list) => ({
      id: list.id,
      name: list.name,
      reason: list.reason,
    })),
    strings: {
      title: t("dialog.title", { user: "{user}" }),
      ariaLabel: t("dialog.ariaLabel"),
      confirm: t("dialog.confirm"),
      processing: t("dialog.processing"),
      cancel: t("common.cancel"),
    },
  });

  if (result.kind === "cancel") {
    unsuppressLayers();
    const cancel = document.querySelector(SEL.cancelButton);
    if (cancel) simulateClick(cancel);
    else await dismissMenu();
    return;
  }

  // 先让 X 的弹窗恢复，再点它的确认按钮，请求由 X 发出。
  unsuppressLayers();
  const confirm = document.querySelector<HTMLElement>(SEL.confirmButton);
  if (confirm) simulateClick(confirm);
  await waitFor(
    () => (document.querySelector(SEL.dialog) ? null : true),
    5_000,
  );
  await dismissMenu();

  // 本地先生效，再提交平台（平台不会立刻更新列表）。
  await deps.addOverlay(pending.userId, pending.screenName, result.listIds);
  const notice = await deps.submit(
    { userId: pending.userId, screenName: pending.screenName },
    result.listIds,
    { id: pending.tweetId, url: pending.tweetUrl, text: pending.tweetText },
  );
  if (notice) deps.notify?.(pending.userId, notice);
}
