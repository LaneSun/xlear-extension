/** 弹窗只属于当前页面与当前原生确认框；离开后不再恢复旧页面位置或执行旧按钮。 */
export function watchPageContext(onExit: () => void, element?: Element): () => void {
  const url = location.href;
  const navigation = (window as Window & { navigation?: EventTarget }).navigation;
  let stopped = false;
  const exit = () => {
    if (stopped) return;
    stop();
    onExit();
  };
  const check = () => {
    if (location.href !== url || (element && !element.isConnected)) exit();
  };
  const navigate = (event: Event) => {
    const change = event as Event & { navigationType?: string; destination?: { url: string } };
    // X 更新当前 history.state（例如保存滚动坐标）不意味着离开当前页面。
    if (change.navigationType === "replace" && change.destination?.url === url) return;
    exit();
  };
  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // 老版 Firefox 没有 Navigation API，补上不产生 DOM 变更的 pushState。
  const timer = navigation ? undefined : setInterval(check, 100);
  const events = ["popstate", "hashchange", "pagehide"] as const;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    clearInterval(timer);
    events.forEach((name) => window.removeEventListener(name, exit, true));
    navigation?.removeEventListener("navigate", navigate);
  };
  events.forEach((name) => window.addEventListener(name, exit, true));
  navigation?.addEventListener("navigate", navigate);
  return stop;
}
