/** MAIN world 只读扫描器：从 React fiber 读取身份，通过 DOM 属性交给过滤引擎。 */
import { ATTR, SEL } from "./selectors.ts";
import { type TweetIdentity, tweetIdentity } from "./identity.ts";

interface ReactFiber {
  memoizedProps?: { tweet?: unknown; tweetResult?: unknown };
  return?: ReactFiber | null;
  alternate?: ReactFiber | null;
  memoizedState?: ReactHook | null;
}

interface ReactHook {
  memoizedState?: { snapshot?: { data?: unknown } };
  next?: ReactHook | null;
}

export function readTweetIdentity(element: Element): TweetIdentity | null {
  const key = Object.keys(element).find((name) =>
    name.startsWith("__reactFiber$")
  );
  if (!key) return null;
  let fiber = (element as unknown as Record<string, ReactFiber>)[key];
  // React 可能保留上一轮 fiber；用本帖的时间戳链接筛掉旧身份及引用帖。
  const permalink = [
    ...element.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'),
  ]
    .find((link) =>
      link.querySelector("time") && link.closest(SEL.tweet) === element
    );
  const wrapper = element.closest('[data-href*="/status/"]');
  const href = wrapper?.getAttribute("data-href") ??
    element.getAttribute("itemid") ??
    permalink?.getAttribute("href");
  const domId = href?.match(/\/status\/(\d+)/)?.[1];
  for (
    let depth = 0;
    fiber && depth < 40;
    depth++, fiber = fiber.return ?? undefined
  ) {
    for (const node of [fiber, fiber.alternate]) {
      const props = node?.memoizedProps;
      const found = tweetIdentity(props?.tweet) ??
        tweetIdentity(props?.tweetResult);
      if (found && (!domId || domId === found.tweetId)) return found;
      // 新版移动 X 用 Relay：props 只带 fragment 引用，已解析的本帖在 hook 的 snapshot.data。
      // 只检查当前 fiber 的有限 hook 链，不访问 Relay store、不读取网络响应或查询标识。
      if (
        props &&
        ("tweet" in props || "tweetResults" in props || "tweetResult" in props)
      ) {
        let hook = node?.memoizedState;
        for (let index = 0; hook && index < 20; index++, hook = hook.next) {
          const resolved = tweetIdentity(hook.memoizedState?.snapshot?.data);
          if (resolved && (!domId || domId === resolved.tweetId)) {
            return resolved;
          }
        }
      }
    }
  }
  return null;
}

function setAttribute(element: Element, key: string, value?: string): void {
  if (value === undefined) {
    if (element.hasAttribute(key)) element.removeAttribute(key);
  } else if (element.getAttribute(key) !== value) {
    element.setAttribute(key, value);
  }
}

function mark(element: Element): void {
  const tweet = readTweetIdentity(element);
  const identity = `${tweet?.tweetId ?? ""}|${tweet?.userId ?? ""}|${
    tweet?.screenName ?? ""
  }`;
  if (element.getAttribute(ATTR.identity) !== identity) {
    setAttribute(element, ATTR.identity, identity);
    element.removeAttribute(ATTR.decided);
    element.removeAttribute("data-xlear-shown");
    // 遮罩与辅助技术状态由过滤引擎统一恢复，不能提前丢掉清理依据。
  }
  setAttribute(element, ATTR.tweet, tweet?.tweetId);
  setAttribute(element, ATTR.user, tweet?.userId);
  setAttribute(element, ATTR.name, tweet?.screenName);
  setAttribute(element, ATTR.checked, "1");
}

export function installScanner(): () => void {
  const dirty = new Set<Element>();
  let scheduled = false;
  let stopped = false;
  const queue = (element: Element) => {
    dirty.add(element);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (stopped) return;
      for (const tweet of dirty) if (tweet.isConnected) mark(tweet);
      dirty.clear();
    });
  };
  const scanAll = () => {
    if (!document.hidden) document.querySelectorAll(SEL.tweet).forEach(queue);
  };
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const target = mutation.target instanceof Element
        ? mutation.target
        : mutation.target.parentElement;
      // 忽略扩展自己的占位文案，避免 DOM → 扫描 → DOM 的循环。
      if (target?.closest("[data-xlear-overlay]")) continue;
      const parent = target?.closest(SEL.tweet);
      if (parent) queue(parent);
      for (const node of mutation.addedNodes) {
        if (
          !(node instanceof Element) || node.matches("[data-xlear-overlay]")
        ) continue;
        if (node.matches(SEL.tweet)) queue(node);
        node.querySelectorAll(SEL.tweet).forEach(queue);
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["href", "data-href", "itemid"],
  });
  document.addEventListener("visibilitychange", scanAll);
  const timer = setInterval(scanAll, 5_000);
  scanAll();
  return () => {
    stopped = true;
    observer.disconnect();
    clearInterval(timer);
    dirty.clear();
    document.removeEventListener("visibilitychange", scanAll);
  };
}
