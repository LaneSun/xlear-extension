/** 弹窗与设置页共用的小组件。图标统一从 lucide 取，尺寸与线宽由 Icon 兜住。 */
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { ListSummary } from "../../shared/types.ts";
import { Search, type LucideIcon, type LucideProps } from "lucide-preact";
import { t } from "../i18n.ts";
// 叶子模块按相对路径引入：页面与内容脚本都不该被 shared/mod.ts 的整桶依赖拖累。
import {
  LOGO_SHIELD,
  LOGO_VIEWBOX,
  LOGO_X_ARMS,
  LOGO_X_CLIP,
  LOGO_X_STROKE,
} from "../../shared/logo.ts";

export function Icon(
  { icon: Glyph, size = 16, class: extraClass, ...rest }: LucideProps & {
    icon: LucideIcon;
    class?: string;
  },
) {
  return (
    <Glyph
      size={size}
      // 同样必须用连字符：camelCase 到不了 DOM，lucide 的默认 2 会一直在生效。
      stroke-width={1.75}
      aria-hidden="true"
      // lucide 自己拼 class 属性，附加类名必须走 className。
      className={extraClass ? `xl-icon ${extraClass}` : "xl-icon"}
      {...rest}
    />
  );
}

/**
 * Xlear 标志：白色盾牌 + 中间黑色 X。
 *
 * - 盾牌用 `currentColor` 填充，X 是镂空（透明）的：深色背景下就是"白盾 + 黑 X"，
 *   亮色背景下 currentColor 变黑，自动成为"黑盾 + 白 X"（即反色）。
 * - X 的上下缘是平的（只按水平线裁切），左右保持笔画自身的尖角，与 X 的官方字形一致。
 *   注意 45° 交叉 + 水平裁切时，X 的宽度天然等于"高度 + 笔画 × √2"，所以笔画越细越显窄。
 */
export function Logo({ size = 24 }: { size?: number }) {
  // 每个实例用独立的 mask/clip id，同一页放多个 Logo 也不会互相顶掉。
  const id = `xlear-logo-${++logoSeq}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox={LOGO_VIEWBOX}
      role="img"
      aria-label="Xlear"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        {/* 注意：Preact 不会把 camelCase 转成 SVG 的连字符属性，写成 strokeWidth / clipPath
            会被原样塞进 DOM 并被浏览器忽略（掩膜里的笔画会退回默认 1px）。 */}
        <clipPath id={`c-${id}`}>
          <rect x="0" y={LOGO_X_CLIP.y} width="128" height={LOGO_X_CLIP.height} />
        </clipPath>
        <mask id={`m-${id}`}>
          <rect width="128" height="128" fill="#fff" />
          <g clip-path={`url(#c-${id})`}>
            <path
              d={LOGO_X_ARMS}
              stroke="#000"
              stroke-width={LOGO_X_STROKE}
              stroke-linecap="butt"
              fill="none"
            />
          </g>
        </mask>
      </defs>
      <path d={LOGO_SHIELD} mask={`url(#m-${id})`} />
    </svg>
  );
}

/** 每个实例用独立的 mask/clip id。 */
let logoSeq = 0;

export function Card(
  props: {
    title?: string;
    subtitle?: string;
    icon?: LucideIcon;
    children: ComponentChildren;
  },
) {
  return (
    <section class="xl-card" style="margin-bottom: 16px;">
      {props.title && (
        <h2 style="margin: 0 0 4px; font-size: 16px; display: flex; align-items: center; gap: 8px;">
          {props.icon && <Icon icon={props.icon} size={16} class="xl-muted" />}
          {props.title}
        </h2>
      )}
      {props.subtitle && (
        <p class="xl-muted" style="margin: 0 0 12px; font-size: 13px;">{props.subtitle}</p>
      )}
      {props.children}
    </section>
  );
}

export function Row(
  props: { label: string; hint?: string; icon?: LucideIcon; children: ComponentChildren },
) {
  return (
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0;">
      <div style="min-width: 0;">
        <div style="font-weight: 600; display: flex; align-items: center; gap: 6px;">
          {props.icon && <Icon icon={props.icon} size={15} class="xl-muted" />}
          {props.label}
        </div>
        {props.hint && (
          <div class="xl-muted" style="font-size: 12px; margin-top: 2px;">{props.hint}</div>
        )}
      </div>
      <div style="flex: none; display: flex; align-items: center; gap: 8px;">{props.children}</div>
    </div>
  );
}

export function Field(
  props: { label: string; hint?: string; children: ComponentChildren },
) {
  return (
    <label style="display: block; margin-bottom: 12px;">
      <span style="display: block; font-weight: 600; margin-bottom: 4px;">{props.label}</span>
      {props.hint && (
        <span class="xl-muted" style="display: block; font-size: 12px; margin-bottom: 6px;">
          {props.hint}
        </span>
      )}
      {props.children}
    </label>
  );
}

export function Chip(props: { tone?: "accent" | "danger" | "success"; children: ComponentChildren }) {
  const cls = props.tone ? `xl-chip xl-chip-${props.tone}` : "xl-chip";
  return <span class={cls}>{props.children}</span>;
}

export function Banner(props: { tone: "info" | "error" | "success"; children: ComponentChildren }) {
  const color = props.tone === "error"
    ? "var(--danger)"
    : props.tone === "success"
    ? "var(--success)"
    : "var(--accent)";
  return (
    <div
      style={{
        border: `1px solid ${color}`,
        color,
        borderRadius: "12px",
        padding: "10px 12px",
        marginBottom: "12px",
        fontSize: "13px",
        lineHeight: "18px",
        wordBreak: "break-word",
      }}
    >
      {props.children}
    </div>
  );
}

export function Spinner(props: { label?: string }) {
  return <span class="xl-muted" style="font-size: 13px;">{props.label ?? "…"}</span>;
}

/**
 * 订阅列表选择器：选项页与欢迎页共用同一份实现（含搜索），两处观感与行为一致。
 *
 * 搜索匹配列表名、理由与列表 ID——ID 是英文短名（如 adult-traffic），中文界面下搜它也好使。
 */
export function ListPicker(
  props: {
    lists: ListSummary[];
    isSelected: (listId: string) => boolean;
    onToggle: (listId: string, checked: boolean) => void;
    busy?: boolean;
    /** 一个列表都没有时的文案（与"搜索无结果"区分开）。 */
    emptyText: string;
  },
) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = needle.length === 0 ? props.lists : props.lists.filter((list) =>
    list.name.toLowerCase().includes(needle) ||
    list.reason.toLowerCase().includes(needle) ||
    list.id.toLowerCase().includes(needle)
  );

  return (
    <>
      <div class="xl-search">
        <Icon icon={Search} size={16} class="xl-search-icon" />
        <input
          class="xl-input"
          type="search"
          value={query}
          placeholder={t("lists.search")}
          aria-label={t("lists.search")}
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
        />
      </div>
      {visible.length === 0
        ? (
          <p class="xl-list-empty">
            {props.lists.length === 0 ? props.emptyText : t("lists.noMatch", { q: query.trim() })}
          </p>
        )
        : visible.map((list) => {
          const checked = props.isSelected(list.id);
          return (
            <label key={list.id} class="xl-list-row">
              <input
                type="checkbox"
                checked={checked}
                disabled={props.busy}
                onChange={(event) => props.onToggle(list.id, (event.target as HTMLInputElement).checked)}
              />
              <span class="xl-list-body">
                <span class="xl-list-head">
                  <span class="xl-list-name">{list.name}</span>
                  <Chip>{t("list.subscribers", { n: list.subscriberCount.toLocaleString() })}</Chip>
                  <Chip>{t("list.entries", { n: list.entryCount.toLocaleString() })}</Chip>
                </span>
                <span class="xl-list-reason">{list.reason}</span>
              </span>
            </label>
          );
        })}
    </>
  );
}
