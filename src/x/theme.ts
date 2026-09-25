/**
 * 读取 X 当前的配色，让扩展插入的 UI 与页面观感一致。
 *
 * 明暗主题以 `<meta name="theme-color">` 为准（X 会把它设成 #000000 / #ffffff）；
 * 正文色直接从页面上已渲染的元素取，取不到时回退到内置默认值。
 * 注意：不要用 `document.body` 的 computed fontFamily —— 系统字体回退会污染它，
 * 字体一律使用 X 的真实字体栈。
 */

export const X_FONT_STACK =
  'TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "PingFang SC", "Microsoft YaHei", sans-serif';

export interface XTheme {
  dark: boolean;
  background: string;
  panel: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  danger: string;
  mask: string;
}

const DARK: Pick<XTheme, "background" | "panel" | "text" | "muted" | "border" | "accent" | "danger" | "mask"> = {
  background: "rgb(0, 0, 0)",
  panel: "rgb(22, 24, 28)",
  text: "rgb(231, 233, 234)",
  muted: "rgb(113, 118, 123)",
  border: "rgb(47, 51, 54)",
  accent: "rgb(29, 155, 240)",
  danger: "rgb(244, 33, 46)",
  mask: "rgba(91, 112, 131, 0.4)",
};

const LIGHT: typeof DARK = {
  background: "rgb(255, 255, 255)",
  panel: "rgb(247, 249, 249)",
  text: "rgb(15, 20, 25)",
  muted: "rgb(83, 100, 113)",
  border: "rgb(239, 243, 244)",
  accent: "rgb(29, 155, 240)",
  danger: "rgb(244, 33, 46)",
  mask: "rgba(0, 0, 0, 0.4)",
};

export function readTheme(): XTheme {
  const meta = document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? "";
  const dark = meta.toLowerCase() === "#000000";
  const palette = dark ? DARK : LIGHT;
  const textSample = document.querySelector('[data-testid="tweetText"]');
  const text = textSample ? getComputedStyle(textSample).color : palette.text;
  return { dark, ...palette, text };
}

/**
 * 供 CSS 变量使用的一串声明（**以分号结尾**）。
 *
 * 结尾这个分号是必须的：调用方通常写成 `:host { ${声明} 其它属性 }`，
 * 少了它，下一条属性会被当成 `--xlear-font` 值的一部分（自定义属性会一路吃到分号），
 * 整条字体声明随之作废，弹窗会退化成系统默认字体。
 */
export function themeVariables(theme: XTheme): string {
  return [
    `--xlear-bg: ${theme.background}`,
    `--xlear-panel: ${theme.panel}`,
    `--xlear-text: ${theme.text}`,
    `--xlear-muted: ${theme.muted}`,
    `--xlear-border: ${theme.border}`,
    `--xlear-accent: ${theme.accent}`,
    `--xlear-danger: ${theme.danger}`,
    `--xlear-mask: ${theme.mask}`,
    `--xlear-font: ${X_FONT_STACK}`,
  ].join(";") + ";";
}
