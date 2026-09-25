/**
 * Xlear 标志的几何：一处定义，两端（扩展与服务端）共用。
 *
 * 盾牌用 `currentColor` 填充，X 是镂空掩膜——深色页面上是"白盾 + 黑 X"，
 * 亮色页面上 currentColor 变深，自动成为"黑盾 + 白 X"。
 *
 * X 只按**水平线**裁切：上下缘平、左右保留笔画自身的尖角（X 官方字形的处理方式）。
 * 45° 交叉 + 水平裁切时，X 的宽度恒等于"高度 + 笔画 × √2"，所以笔画越细越显窄。
 *
 * 两个不参与运行时的产物由这套几何导出，改这里要同步它们：
 * `extension/assets/logo.svg`（主题感知版）、`extension/assets/logo-solid.svg`（图标 PNG 的源）、
 * 网站的 favicon 内联了同一份路径。
 */
export const LOGO_VIEWBOX = "0 0 128 128";

/** 盾牌：圆角平顶，两侧收成下方尖角。 */
export const LOGO_SHIELD =
  "M18 8 H110 A8 8 0 0 1 118 16 V58 C118 89 95 111 64 122 C33 111 10 89 10 58 V16 A8 8 0 0 1 18 8 Z";

/** X 的两条 45° 笔画（画得比裁切区更长，端头由裁切线决定）。 */
export const LOGO_X_ARMS = "M20 11 L108 99 M108 11 L20 99";

/** 笔画宽度。 */
export const LOGO_X_STROKE = 10;

/** 只裁水平的裁切区：y=35、高 40，即 X 的上下缘。 */
export const LOGO_X_CLIP = { y: 35, height: 40 } as const;
