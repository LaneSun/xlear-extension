/** 弹窗与设置页共用的小组件。图标统一从 lucide 取，尺寸与线宽由 Icon 兜住。 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ListSummary } from "../../shared/types.ts";
import {
  Ellipsis,
  ListPlus,
  type LucideIcon,
  type LucideProps,
  Search,
  X,
} from "lucide-preact";
import { t } from "../i18n.ts";
import type { LocalListRow } from "../core/messaging.ts";
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
        {
          /* 注意：Preact 不会把 camelCase 转成 SVG 的连字符属性，写成 strokeWidth / clipPath
            会被原样塞进 DOM 并被浏览器忽略（掩膜里的笔画会退回默认 1px）。 */
        }
        <clipPath id={`c-${id}`}>
          <rect
            x="0"
            y={LOGO_X_CLIP.y}
            width="128"
            height={LOGO_X_CLIP.height}
          />
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
        <p class="xl-muted" style="margin: 0 0 12px; font-size: 13px;">
          {props.subtitle}
        </p>
      )}
      {props.children}
    </section>
  );
}

export function Row(
  props: {
    label: string;
    hint?: string;
    icon?: LucideIcon;
    children: ComponentChildren;
  },
) {
  return (
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0;">
      <div style="min-width: 0;">
        <div style="font-weight: 600; display: flex; align-items: center; gap: 6px;">
          {props.icon && <Icon icon={props.icon} size={15} class="xl-muted" />}
          {props.label}
        </div>
        {props.hint && (
          <div class="xl-muted" style="font-size: 12px; margin-top: 2px;">
            {props.hint}
          </div>
        )}
      </div>
      <div style="flex: none; display: flex; align-items: center; gap: 8px;">
        {props.children}
      </div>
    </div>
  );
}

export function Field(
  props: { label: string; hint?: string; children: ComponentChildren },
) {
  return (
    <label style="display: block; margin-bottom: 12px;">
      <span style="display: block; font-weight: 600; margin-bottom: 4px;">
        {props.label}
      </span>
      {props.hint && (
        <span
          class="xl-muted"
          style="display: block; font-size: 12px; margin-bottom: 6px;"
        >
          {props.hint}
        </span>
      )}
      {props.children}
    </label>
  );
}

export function Chip(
  props: {
    tone?: "accent" | "danger" | "success";
    children: ComponentChildren;
  },
) {
  const cls = props.tone ? `xl-chip xl-chip-${props.tone}` : "xl-chip";
  return <span class={cls}>{props.children}</span>;
}

export function Banner(
  props: { tone: "info" | "error" | "success"; children: ComponentChildren },
) {
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
  return (
    <span class="xl-muted" style="font-size: 13px;">{props.label ?? "…"}</span>
  );
}

/**
 * 订阅列表选择器：选项页与欢迎页共用同一份实现（含搜索），两处观感与行为一致。
 *
 * 只展示**服务器上的**列表：本地列表有自己的区块（`LocalListsPanel`），
 * 它的条目不在服务器、也不该混进"订阅"这个概念里。
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
  const visible = needle.length === 0
    ? props.lists
    : props.lists.filter((list) =>
      list.name.toLowerCase().includes(needle) ||
      list.reason.toLowerCase().includes(needle)
    );

  return (
    <>
      <div class="xl-search-row">
        <div class="xl-search">
          <Icon icon={Search} size={16} class="xl-search-icon" />
          <input
            class="xl-input"
            type="search"
            value={query}
            placeholder={t("lists.search")}
            aria-label={t("lists.search")}
            onInput={(event) =>
              setQuery((event.target as HTMLInputElement).value)}
          />
        </div>
      </div>
      {visible.length === 0
        ? (
          <p class="xl-list-empty">
            {props.lists.length === 0
              ? props.emptyText
              : t("lists.noMatch", { q: query.trim() })}
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
                onChange={(event) =>
                  props.onToggle(
                    list.id,
                    (event.target as HTMLInputElement).checked,
                  )}
              />
              <span class="xl-list-body">
                <span class="xl-list-head">
                  <span class="xl-list-name">{list.name}</span>
                  <Chip>
                    {t("list.subscribers", {
                      n: list.subscriberCount.toLocaleString(),
                    })}
                  </Chip>
                  <Chip>
                    {t("list.entries", { n: list.entryCount.toLocaleString() })}
                  </Chip>
                </span>
                <span class="xl-list-reason">{list.reason}</span>
              </span>
            </label>
          );
        })}
    </>
  );
}

/** 一个本地列表里的账号；与本地覆盖里的一条记录对应。 */
export interface LocalListEntry {
  userId: string;
  screenName?: string;
  tweetUrl?: string;
}

/** 行尾的「…」：一个列表的次要操作收在一处，行本身保持与订阅列表同一套观感。 */
function RowMenu(
  props: {
    label: string;
    disabled?: boolean;
    items: { label: string; tone?: "danger"; onSelect: () => void }[];
  },
) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // 菜单是临时的：点到别处或按 Esc 就收起来，不会一直挂在页面上。
    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span class="xl-menu-wrap" ref={root}>
      <button
        type="button"
        class="xl-icon-btn"
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon icon={Ellipsis} size={18} />
      </button>
      {open && (
        <div class="xl-menu" role="menu">
          {props.items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              class={item.tone === "danger"
                ? "xl-menu-item xl-menu-item-danger"
                : "xl-menu-item"}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** 条目视图：一个本地列表里都有谁 —— 名单是列表，这里才是名单里的人。 */
function EntriesDialog(
  props: {
    name: string;
    entries: LocalListEntry[];
    loading: boolean;
    error: string;
    busy?: boolean;
    onRemove: (userId: string) => void;
    onClose: () => void;
  },
) {
  const title = t("lists.entries.title", { name: props.name });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div class="xl-modal-backdrop" onClick={props.onClose}>
      <div
        class="xl-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div class="xl-modal-head">
          <h3 class="xl-modal-title">{title}</h3>
          <button
            type="button"
            class="xl-icon-btn"
            aria-label={t("common.close")}
            onClick={props.onClose}
          >
            <Icon icon={X} size={18} />
          </button>
        </div>
        {props.loading
          ? <Spinner />
          : props.entries.length === 0
          ? <p class="xl-list-empty">{t("lists.entries.empty")}</p>
          : (
            <ul class="xl-entry-list">
              {props.entries.map((entry) => (
                <li key={entry.userId} class="xl-entry-row">
                  <span class="xl-entry-name">
                    {entry.tweetUrl
                      ? (
                        <a
                          href={entry.tweetUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {`@${entry.screenName ?? entry.userId}`}
                        </a>
                      )
                      : `@${entry.screenName ?? entry.userId}`}
                  </span>
                  <button
                    type="button"
                    class="xl-btn xl-btn-ghost"
                    disabled={props.busy}
                    onClick={() =>
                      props.onRemove(entry.userId)}
                  >
                    {t("options.overlay.remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        {props.error.length > 0 && (
          <p class="xl-muted" style="margin: 0; font-size: 12px;">
            {props.error}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 「我的本地列表」：本地列表有自己的管理入口，行与订阅列表共用同一套观感。
 *
 * 勾选的含义与订阅列表一致 —— 算不算数：停用的列表不再隐藏账号，也不出现在屏蔽理由弹窗里，
 * 但条目原样留着（名字与理由在创建时交过一份记录，之后就与服务器无关）。
 */
export function LocalListsPanel(
  props: {
    rows: LocalListRow[];
    busy?: boolean;
    onCreate: (name: string, reason: string) => void | Promise<void>;
    onRename: (
      id: string,
      name: string,
      reason: string,
    ) => void | Promise<void>;
    onDelete: (id: string) => void | Promise<void>;
    onToggle: (id: string, enabled: boolean) => void | Promise<void>;
    entries: {
      load: (listId: string) => Promise<LocalListEntry[]>;
      remove: (listId: string, userId: string) => Promise<void>;
    };
  },
) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState("");
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState("");
  const [entries, setEntries] = useState<LocalListEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesError, setEntriesError] = useState("");

  async function run(action: () => void | Promise<void>): Promise<void> {
    setError("");
    try {
      await action();
      setCreating(false);
      setEditing("");
      setName("");
      setReason("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function openEntries(listId: string): Promise<void> {
    setViewing(listId);
    setEntries([]);
    setEntriesError("");
    setEntriesLoading(true);
    try {
      setEntries(await props.entries.load(listId));
    } catch (caught) {
      setEntriesError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setEntriesLoading(false);
    }
  }

  async function removeEntry(listId: string, userId: string): Promise<void> {
    await run(async () => {
      await props.entries.remove(listId, userId);
      setEntries(await props.entries.load(listId));
    });
  }

  const viewingRow = props.rows.find((row) => row.id === viewing) ?? null;

  return (
    <>
      <Card
        title={t("lists.mine.title")}
        icon={ListPlus}
      >
        {props.rows.length === 0 && !creating && (
          <p class="xl-list-empty">{t("lists.mine.empty")}</p>
        )}
        {props.rows.length > 0 && (
          <div class="xl-list-rows">
            {props.rows.map((row) => (
              <div key={row.id} class="xl-list-row">
                {editing === row.id
                  ? (
                    <div class="xl-create-form">
                      <input
                        class="xl-input"
                        value={name}
                        maxLength={60}
                        placeholder={t("lists.createName")}
                        onInput={(event) =>
                          setName((event.target as HTMLInputElement).value)}
                      />
                      <textarea
                        class="xl-input"
                        value={reason}
                        maxLength={300}
                        placeholder={t("lists.createReason")}
                        onInput={(event) =>
                          setReason(
                            (event.target as HTMLTextAreaElement).value,
                          )}
                      />
                      <div class="xl-create-actions">
                        <button
                          type="button"
                          class="xl-btn xl-btn-primary"
                          disabled={props.busy || name.trim().length === 0 ||
                            reason.trim().length === 0}
                          onClick={() =>
                            void run(() =>
                              props.onRename(row.id, name.trim(), reason.trim())
                            )}
                        >
                          {t("common.save")}
                        </button>
                        <button
                          type="button"
                          class="xl-btn xl-btn-ghost"
                          onClick={() => setEditing("")}
                        >
                          {t("lists.createCancel")}
                        </button>
                      </div>
                    </div>
                  )
                  : (
                    <>
                      <label class="xl-list-toggle">
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          disabled={props.busy}
                          aria-label={t("lists.mine.apply", { name: row.name })}
                          onChange={(event) =>
                            void run(() =>
                              props.onToggle(
                                row.id,
                                (event.target as HTMLInputElement).checked,
                              )
                            )}
                        />
                        <span class="xl-list-body">
                          <span class="xl-list-head">
                            <span class="xl-list-name">{row.name}</span>
                            {!row.enabled && (
                              <Chip>{t("common.disabled")}</Chip>
                            )}
                            <Chip>{t("lists.mine.local")}</Chip>
                            <Chip>
                              {t("list.entries", {
                                n: row.entries.toLocaleString(),
                              })}
                            </Chip>
                          </span>
                          <span class="xl-list-reason">{row.reason}</span>
                        </span>
                      </label>
                      <RowMenu
                        label={t("lists.mine.more")}
                        disabled={props.busy}
                        items={[
                          {
                            label: t("lists.mine.viewEntries"),
                            onSelect: () => void openEntries(row.id),
                          },
                          {
                            label: t("lists.mine.rename"),
                            onSelect: () => {
                              setName(row.name);
                              setReason(row.reason);
                              setEditing(row.id);
                            },
                          },
                          {
                            label: t("lists.mine.delete"),
                            tone: "danger",
                            onSelect: () => {
                              if (
                                globalThis.confirm(
                                  t("lists.mine.deleteConfirm"),
                                )
                              ) {
                                void run(() => props.onDelete(row.id));
                              }
                            },
                          },
                        ]}
                      />
                    </>
                  )}
              </div>
            ))}
          </div>
        )}
        {creating
          ? (
            <div class="xl-create-form">
              <input
                class="xl-input"
                value={name}
                maxLength={60}
                placeholder={t("lists.createName")}
                onInput={(event) =>
                  setName((event.target as HTMLInputElement).value)}
              />
              <textarea
                class="xl-input"
                value={reason}
                maxLength={300}
                placeholder={t("lists.createReason")}
                onInput={(event) =>
                  setReason((event.target as HTMLTextAreaElement).value)}
              />
              <div class="xl-create-actions">
                <button
                  type="button"
                  class="xl-btn xl-btn-primary"
                  disabled={props.busy || name.trim().length === 0 ||
                    reason.trim().length === 0}
                  onClick={() =>
                    void run(() => props.onCreate(name.trim(), reason.trim()))}
                >
                  {t("lists.createSubmit")}
                </button>
                <button
                  type="button"
                  class="xl-btn xl-btn-ghost"
                  onClick={() => setCreating(false)}
                >
                  {t("lists.createCancel")}
                </button>
              </div>
            </div>
          )
          : (
            <button
              type="button"
              class="xl-btn xl-btn-primary"
              disabled={props.busy}
              onClick={() => {
                setName("");
                setReason("");
                setCreating(true);
              }}
            >
              {t("lists.create")}
            </button>
          )}
        {error.length > 0 && (
          <p class="xl-muted" style="margin: 8px 0 0; font-size: 12px;">
            {error}
          </p>
        )}
      </Card>
      {viewingRow && (
        <EntriesDialog
          name={viewingRow.name}
          entries={entries}
          loading={entriesLoading}
          error={entriesError}
          busy={props.busy}
          onRemove={(userId) => void removeEntry(viewingRow.id, userId)}
          onClose={() => setViewing("")}
        />
      )}
    </>
  );
}
