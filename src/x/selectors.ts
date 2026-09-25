/**
 * X 页面上的选择器与 DOM 约定，集中一处维护。
 *
 * 原则：
 * - 优先用 `data-testid`（X 自己也在用，跨语言稳定）；
 * - 绝不依赖哈希类名（`r-xxxx` 那种每次构建都会变）。
 * X 改版时只需要改这个文件，选项页的诊断会对每一项做存在性自检。
 */

export const SEL = {
  /** 帖子容器。 */
  tweet: 'article[data-testid="tweet"]',
  /** 虚拟列表单元，隐藏时最小影响范围。 */
  cell: '[data-testid="cellInnerDiv"]',
  /** 更多菜单按钮。 */
  caret: '[data-testid="caret"]',
  menu: '[role="menu"]',
  menuItem: '[role="menuitem"]',
  blockItem: '[data-testid="block"]',
  confirmButton: '[data-testid="confirmationSheetConfirm"]',
  cancelButton: '[data-testid="confirmationSheetCancel"]',
  dialog: '[data-testid="confirmationSheetDialog"]',
  layers: "#layers",
  tweetText: '[data-testid="tweetText"]',
} as const;

/** 本扩展加在帖子上的属性，两个世界之间靠它对齐。 */
export const ATTR = {
  /** 作者数字 ID。 */
  user: "data-xlear-user",
  /** 作者用户名。 */
  name: "data-xlear-name",
  /** 帖子自身 ID：X 复用时间线节点，靠它识别"这条 article 已经换帖子了"。 */
  tweet: "data-xlear-tweet",
  /** 上次标记时的 (帖子, 作者) 组合，用于识别节点复用。 */
  identity: "data-xlear-identity",
  /** 已被扫描器处理过（只表示"读到了作者"，不代表已做判定）。 */
  checked: "data-xlear-checked",
  /**
   * 已完成命中判定（隐藏或放行都算）。
   * 防闪规则盯的是这个属性：只盯 `checked` 的话，帖子会在"已扫描、判定还没回来"的
   * 几十毫秒里恢复可见，首屏会露出真实内容。
   */
  decided: "data-xlear-decided",
  /** 命中过滤后被隐藏的帖子。 */
  filtered: "data-xlear-filtered",
} as const;

/** 从帖子元素找到它所属的虚拟列表单元。 */
export function cellOf(tweet: Element): HTMLElement | null {
  return tweet.closest<HTMLElement>(SEL.cell);
}
