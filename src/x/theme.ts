/**
 * 读取 X 当前的配色，让扩展插入的 UI 与页面观感一致。
 *
 * 优先采用页面实际绘制的背景；theme-color 只是浏览器工具栏颜色，可能与页面不同步。
 * 页面还未绘制背景时，再依次采用匹配当前媒体条件的 theme-color 与系统配色。
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

const DARK: Pick<
  XTheme,
  | "background"
  | "panel"
  | "text"
  | "muted"
  | "border"
  | "accent"
  | "danger"
  | "mask"
> = {
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

/** 只接受不透明的实际颜色，透明容器不能决定页面主题。 */
function opaqueColor(value: string): { css: string; rgb: number[] } | null {
  const color = value.trim().toLowerCase();
  const hex = color.match(/^#([\da-f]{3}|[\da-f]{6})$/);
  if (hex?.[1]) {
    const expanded = hex[1].length === 3
      ? [...hex[1]].map((c) => c + c).join("")
      : hex[1];
    return {
      css: color,
      rgb: [0, 2, 4].map((i) => parseInt(expanded.slice(i, i + 2), 16)),
    };
  }
  const rgb = color.match(/^rgba?\(([^)]+)\)$/);
  if (!rgb?.[1]) return null;
  const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const alpha = parts[3] === undefined
    ? 1
    : parseFloat(parts[3]) / (parts[3].endsWith("%") ? 100 : 1);
  const channels = parts.slice(0, 3).map((part) =>
    parseFloat(part) * (part.endsWith("%") ? 2.55 : 1)
  );
  return alpha >= 0.99 &&
      channels.every((c) => Number.isFinite(c) && c >= 0 && c <= 255)
    ? { css: color, rgb: channels }
    : null;
}

export function readTheme(): XTheme {
  const roots = [
    document.querySelector("#react-root"),
    document.body,
    document.documentElement,
  ];
  let surface = roots.map((node) =>
    node ? opaqueColor(getComputedStyle(node).backgroundColor) : null
  )
    .find((color) => color !== null);
  if (!surface) {
    const metas = [
      ...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
    ];
    const active = metas.find((meta) =>
      meta.media && matchMedia(meta.media).matches
    ) ??
      metas.find((meta) => !meta.media);
    surface = opaqueColor(active?.content ?? "") ?? undefined;
  }
  const dark = surface
    ? (surface.rgb[0]! * 0.2126 + surface.rgb[1]! * 0.7152 +
      surface.rgb[2]! * 0.0722) < 128
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const dim = dark && surface && surface.rgb.some((channel) => channel > 8);
  const palette = dark ? DARK : LIGHT;
  return {
    dark,
    ...palette,
    ...(surface ? { background: surface.css } : {}),
    ...(dim ? { panel: "#1e2732" } : {}),
  };
}

/** 弹窗打开期间也跟随 X 切换主题，关闭时解除监听。 */
export function observeTheme(update: (theme: XTheme) => void): () => void {
  let frame = 0;
  const schedule = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        update(readTheme());
      });
    }
  };
  const observer = new MutationObserver(schedule);
  for (
    const node of [
      document.documentElement,
      document.body,
      document.querySelector("#react-root"),
    ]
  ) {
    if (node) {
      observer.observe(node, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
    }
  }
  if (document.head) {
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["content", "media", "href"],
    });
  }
  const media = matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", schedule);
  update(readTheme());
  return () => {
    observer.disconnect();
    media.removeEventListener("change", schedule);
    cancelAnimationFrame(frame);
  };
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
    `--xlear-color-scheme: ${theme.dark ? "dark" : "light"}`,
  ].join(";") + ";";
}
