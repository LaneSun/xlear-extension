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
import type { ReasonHistory } from "../core/reason-history.ts";
import { isReasonDialogOpen, showReasonDialog } from "./dialog.ts";
import {
  dismissMenu,
  simulateClick,
  suppressLayers,
  unsuppressLayers,
  waitFor,
} from "./executor.ts";
import { ATTR, postLink, SEL } from "./selectors.ts";
import { watchPageContext } from "./page-context.ts";

/** 等 X 的更多菜单出现的时间；超过就认为这条走不通。 */
const BLOCK_MENU_TIMEOUT_MS = 2_500;

export interface BlockMenuDeps {
  enabled?: () => boolean;
  /**
   * 可以拿来当举报理由的名单：后台下发的已订阅服务器列表，加上已启用的本地列表。
   * 这里只要弹窗真正用到的三个字段，不必是完整的目录条目。
   */
  lists: () => { id: string; name: string; reason: string }[];
  /** 每次打开时读取本机记录，让多个标签页共用最近选择。 */
  history?: () => Promise<ReasonHistory>;
  /** 提交举报；返回给用户看的提示文案。 */
  submit: (
    target: { userId: string; screenName?: string },
    listIds: string[],
    tweet: { id: string; url?: string },
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
}

/**
 * 卡片上的「在 X 上屏蔽」发起时置位：这一次的菜单点击直通 X。
 *
 * 该按钮的语义是"替用户点一下 X 原本的屏蔽入口"，所以要让 X 弹出**它自己**的确认弹窗，
 * 而不是插进我们的理由弹窗（那属于"用户自己在 X 上点屏蔽"的路径）。
 * 只在 `simulateClick` 那一瞬间为真：拦截器读到时立刻返回并复位。
 */
let passThroughToX = false;

export function installBlockMenuInterceptor(deps: BlockMenuDeps): () => void {
  let pending: PendingTarget | null = null;
  let openedAt = 0;
  let intercepting = false;
  let active: AbortController | undefined;
  const onClick = (event: MouseEvent) => {
    if (deps.enabled?.() === false) {
      pending = null;
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    const caret = target.closest(SEL.caret);
    if (caret) {
      const article = caret.closest(SEL.tweet);
      pending = article ? readPendingTarget(article) : null;
      openedAt = Date.now();
      return;
    }
    // 移动端底部菜单可能只有 role=button；屏蔽的 testid 跨布局稳定。
    const item = target.closest(SEL.blockItem) ?? target.closest(SEL.menuItem);
    if (
      !item ||
      !(item.matches(SEL.blockItem) || item.querySelector(SEL.blockItem))
    ) {
      // 离开当前菜单后不再沿用旧目标，避免随后在别处屏蔽时误报上一条帖子。
      pending = null;
      return;
    }
    if (passThroughToX || intercepting || isReasonDialogOpen()) return;
    const selected = Date.now() - openedAt < 30_000 ? pending : null;
    pending = null;
    if (!selected) return;
    intercepting = true;
    const controller = new AbortController();
    active = controller;
    void handleInterceptedBlock(selected, deps, controller).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      deps.notify?.(
        selected.userId,
        t("dialog.submitFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }).finally(() => {
      intercepting = false;
      if (active === controller) active = undefined;
      unsuppressLayers();
    });
  };
  document.addEventListener("click", onClick, true);
  return () => {
    active?.abort();
    document.removeEventListener("click", onClick, true);
  };
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
  const controller = new AbortController();
  const identity = article.getAttribute(ATTR.identity);
  const stopPageWatch = watchPageContext(() => controller.abort(), article);
  const interrupt = () => controller.abort();
  const inputEvents = ["pointerdown", "keydown", "click"] as const;
  const stopInputWatch = () =>
    inputEvents.forEach((name) => document.removeEventListener(name, interrupt, true));
  try {
    simulateClick(caret);
    // 等待期间用户转去操作别处时，不再代点随后出现的另一份菜单。
    inputEvents.forEach((name) => document.addEventListener(name, interrupt, true));
    const item = await waitFor(findBlockMenuItem, BLOCK_MENU_TIMEOUT_MS, 100, controller.signal);
    stopInputWatch();
    if (
      controller.signal.aborted || !article.isConnected ||
      article.getAttribute(ATTR.identity) !== identity
    ) return null;
    if (!item) {
      // 只处理当前页面的菜单，导航之后不能把新页面的菜单一起关掉。
      await dismissMenu();
      return t("card.blockUnavailable");
    }
    // 只在这一次派发期间置位，直通 X 的原生确认流程。
    passThroughToX = true;
    try {
      simulateClick(item);
    } finally {
      passThroughToX = false;
    }
    return null;
  } finally {
    stopInputWatch();
    stopPageWatch();
  }
}

/** 菜单里的「屏蔽」项。静音项不认——按钮的语义就是在 X 上屏蔽。 */
function findBlockMenuItem(): HTMLElement | null {
  // 不要求 role=menu，移动 X 使用底部操作面板。
  return [...document.querySelectorAll<HTMLElement>(SEL.blockItem)]
    .find((item) => item.getClientRects().length > 0) ?? null;
}

function confirmationDialog(): Element | null {
  const button = document.querySelector(SEL.confirmButton);
  return button?.closest(
    `${SEL.dialog}, [role="dialog"], [role="alertdialog"]`,
  ) ?? null;
}

function readPendingTarget(article: Element): PendingTarget | null {
  const userId = article.getAttribute(ATTR.user);
  if (!userId) return null;
  const screenName = article.getAttribute(ATTR.name) ?? undefined;
  const link = postLink(article);
  const href = link?.getAttribute("href") ?? undefined;
  const tweetId = article.getAttribute(ATTR.tweet) ??
    href?.match(/\/status\/(\d+)/)?.[1];
  if (!tweetId) return null;

  return {
    userId,
    screenName,
    tweetId,
    tweetUrl: href ? new URL(href, location.origin).toString() : undefined,
  };
}

async function handleInterceptedBlock(
  pending: PendingTarget,
  deps: BlockMenuDeps,
  controller: AbortController,
): Promise<void> {
  // X 已经在打开它自己的确认弹窗，先藏起来。
  // 一条能用的名单都没有时**不介入**：理由弹窗没有东西可选，插一脚只会挡住 X 自己的屏蔽流程。
  // 判断放在最前面 —— 此时还没藏 X 的弹窗，直接返回等于我们不存在。
  // 名单由调用方给定（已订阅的服务器列表 + 已启用的本地列表），这里再做一次防御性过滤。
  const available = deps.lists().filter((list) => list.id.length > 0);
  if (available.length === 0) return;

  const { signal } = controller;
  let stopPageWatch = watchPageContext(() => controller.abort());
  try {
    suppressLayers();
    const dialogPresent = await waitFor(
      confirmationDialog,
      2_000,
      100,
      signal,
    );
    if (!dialogPresent || signal.aborted || deps.enabled?.() === false) {
      // 没等到 X 的弹窗（例如它是直接屏蔽、无确认），此时不必插入我们的流程。
      unsuppressLayers();
      return;
    }

    stopPageWatch();
    stopPageWatch = watchPageContext(() => controller.abort(), dialogPresent);
    const history = await Promise.race([
      deps.history?.().catch(() => undefined),
      new Promise<undefined>((resolve) =>
        signal.addEventListener("abort", () => resolve(undefined), { once: true })
      ),
    ]);
    if (signal.aborted || !dialogPresent.isConnected || deps.enabled?.() === false) {
      unsuppressLayers();
      return;
    }
    const result = await showReasonDialog({
      signal,
      history,
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
        reusePrevious: t("dialog.reusePrevious"),
        reusePreviousHint: t("dialog.reusePreviousHint", { lists: "{lists}" }),
      },
    });

    if (signal.aborted || !dialogPresent.isConnected) return;
    // 从这里起是用户已完成的选择；正常关闭原生框不再被误认为页面失效。
    stopPageWatch();
    if (result.kind === "cancel" || deps.enabled?.() === false) {
      unsuppressLayers();
      const cancel = dialogPresent.querySelector(SEL.cancelButton);
      if (cancel) simulateClick(cancel);
      else await dismissMenu();
      return;
    }

    // 先让 X 的弹窗恢复，再点它的确认按钮，请求由 X 发出。
    unsuppressLayers();
    const confirm = dialogPresent.querySelector<HTMLElement>(SEL.confirmButton);
    if (
      !dialogPresent.isConnected || !confirm ||
      confirm.matches(":disabled, [aria-disabled=true]")
    ) {
      deps.notify?.(pending.userId, t("card.blockUnavailable"));
      return;
    }
    simulateClick(confirm);
    const closed = await waitFor(
      () => !dialogPresent.isConnected ? true : null,
      5_000,
    );
    if (!closed) {
      deps.notify?.(pending.userId, t("card.blockUnavailable"));
      return;
    }
    // 本地先生效，再提交平台（平台不会立刻更新列表）。
    await deps.addOverlay(pending.userId, pending.screenName, result.listIds);
    const notice = await deps.submit(
      { userId: pending.userId, screenName: pending.screenName },
      result.listIds,
      { id: pending.tweetId, url: pending.tweetUrl },
    );
    if (notice) deps.notify?.(pending.userId, notice);
  } finally {
    stopPageWatch();
  }
}
