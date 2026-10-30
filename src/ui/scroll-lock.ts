/** 两类弹窗共用页面滚动锁，保留原有内联样式和滚动位置。 */
export function lockPageScroll(): (restorePosition?: boolean) => void {
  const root = document.documentElement;
  const body = document.body;
  const x = window.scrollX;
  const y = window.scrollY;
  const restore: (() => void)[] = [];
  const set = (node: HTMLElement, property: string, value: string) => {
    const previous = node.style.getPropertyValue(property);
    const priority = node.style.getPropertyPriority(property);
    // X 已经持有的锁不属于我们；它先解锁时不能把旧 hidden 再写回去。
    if (previous === value) return;
    node.style.setProperty(property, value, priority);
    restore.push(() => {
      if (
        node.style.getPropertyValue(property) !== value ||
        node.style.getPropertyPriority(property) !== priority
      ) return;
      if (previous) node.style.setProperty(property, previous, priority);
      else node.style.removeProperty(property);
    });
  };
  if (getComputedStyle(root).scrollbarGutter === "auto") set(root, "scrollbar-gutter", "stable");
  // 分开保存长属性，避免不同的 x/y 值或 !important 优先级被 shorthand 吞掉。
  for (const node of [root, body]) {
    set(node, "overflow-x", "hidden");
    set(node, "overflow-y", "hidden");
  }
  let released = false;
  return (restorePosition = true) => {
    if (released) return;
    released = true;
    restore.reverse().forEach((undo) => undo());
    if (restorePosition) window.scrollTo({ left: x, top: y, behavior: "instant" });
  };
}
