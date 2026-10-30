/** 两类弹窗共用页面滚动锁，保留原有内联样式和滚动位置。 */
export function lockPageScroll(): () => void {
  const root = document.documentElement;
  const body = document.body;
  const x = window.scrollX;
  const y = window.scrollY;
  const rootOverflow = root.style.overflow;
  const bodyOverflow = body.style.overflow;
  const gutter = root.style.scrollbarGutter;
  if (getComputedStyle(root).scrollbarGutter === "auto") root.style.scrollbarGutter = "stable";
  root.style.overflow = "hidden";
  body.style.overflow = "hidden";
  return () => {
    root.style.overflow = rootOverflow;
    body.style.overflow = bodyOverflow;
    root.style.scrollbarGutter = gutter;
    window.scrollTo({ left: x, top: y, behavior: "instant" });
  };
}
