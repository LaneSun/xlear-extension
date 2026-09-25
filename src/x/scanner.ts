/**
 * 页面环境的扫描器（MAIN world，**纯只读**）。
 *
 * 唯一的职责：从 React fiber 里读出每个帖子对应的账号，把作者 ID / 用户名写到 DOM 属性上。
 * 两个世界共享 DOM，属性是最省事的对齐方式；过滤引擎据此匹配本地过滤库。
 *
 * 为什么不解析 GraphQL 响应：渲染出的帖子 fiber 已经包含所需字段，
 * 覆盖面相同且不依赖随时会变的响应结构。这里不读也不改 X 的任何请求。
 */
import { ATTR } from "./selectors.ts";

interface ReactFiber {
  memoizedProps?: unknown;
  return?: ReactFiber | null;
}

interface TweetUser {
  id_str?: string;
  rest_id?: string;
  screen_name?: string;
  core?: { screen_name?: string };
}

interface TweetLike {
  rest_id?: string;
  id_str?: string;
  legacy?: { id_str?: string };
  user?: TweetUser;
}

const MAX_FIBER_DEPTH = 40;

function fiberOf(element: Element): ReactFiber | null {
  const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
  if (!key) return null;
  const fiber = (element as unknown as Record<string, ReactFiber | undefined>)[key];
  return fiber ?? null;
}

/** 沿 fiber 向上找承载 tweet 属性的那一层。 */
function findTweet(element: Element): TweetLike | null {
  let node = fiberOf(element);
  for (let depth = 0; node && depth < MAX_FIBER_DEPTH; depth++) {
    const props = node.memoizedProps;
    if (props && typeof props === "object" && "tweet" in props) {
      const tweet = (props as { tweet?: unknown }).tweet;
      if (tweet && typeof tweet === "object" && (tweet as TweetLike).user) {
        return tweet as TweetLike;
      }
    }
    node = node.return ?? null;
  }
  return null;
}

/**
 * 给帖子打标记。认不出作者时也要标记：过滤引擎的规则是"未标记的帖子先挡住"，
 * 漏标记会让整条时间线一直空白。
 */
function mark(element: Element): void {
  const tweet = findTweet(element);
  const user = tweet?.user;
  const userId = user?.id_str ?? user?.rest_id;
  const screenName = user?.screen_name ?? user?.core?.screen_name;
  const tweetId = tweet?.rest_id ?? tweet?.id_str ?? tweet?.legacy?.id_str;

  // 虚拟列表会把同一个 <article> 交给下一条帖子，DOM 属性会原地留着。
  // 身份变了就必须清掉上一条的判定结果，否则新帖子会"继承"上一条的
  // 「已判定/已隐藏」状态，在重新扫描前会短暂露出来。
  const identity = `${tweetId ?? ""}|${userId ?? ""}|${screenName ?? ""}`;
  if (element.getAttribute(ATTR.identity) !== identity) {
    element.setAttribute(ATTR.identity, identity);
    element.removeAttribute(ATTR.decided);
    element.removeAttribute(ATTR.filtered);
    element.removeAttribute("data-xlear-shown");
  }

  if (tweetId) element.setAttribute(ATTR.tweet, String(tweetId));
  if (userId) element.setAttribute(ATTR.user, String(userId));
  if (screenName) element.setAttribute(ATTR.name, String(screenName));
  element.setAttribute(ATTR.checked, "1");
}

export function installScanner(): void {
  const scanAll = () => {
    for (const element of document.querySelectorAll('[data-testid="tweet"]')) mark(element);
  };

  scanAll();
  document.addEventListener("DOMContentLoaded", scanAll, { once: true });

  const observer = new MutationObserver((mutations) => {
    let dirty = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        dirty = true;
        if (node.matches('[data-testid="tweet"]')) mark(node);
        for (const nested of node.querySelectorAll('[data-testid="tweet"]')) mark(nested);
      }
    }
    // 虚拟列表会复用节点，变化后整体重扫一遍，保证新出现的帖子都被标记。
    if (dirty) scanAll();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 低频兜底重扫：对某些只改属性不改结构的渲染做一次补齐。
  setInterval(scanAll, 5_000);
}
