import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ListSummary } from "../../shared/types.ts";
import type {
  AllowListResponse,
  ConfigResponse,
  DiagnoseCheck,
  DiagnoseResponse,
  ListsResponse,
  OverlayListResponse,
  StatusResponse,
  SyncNowResponse,
  WebdavResultResponse,
} from "../../src/core/messaging.ts";
import { sendMessage } from "../../src/core/messaging.ts";
import type { ExtensionConfig, LocaleSetting } from "../../src/core/config.ts";
import type { AllowRecord, OverlayRecord } from "../../src/core/storage.ts";
import { exportToFile, importFromFile } from "../../src/sync/webdav.ts";
import {
  Eraser,
  Globe,
  Inbox,
  ListChecks,
  RefreshCw,
  Settings2,
  ShieldOff,
  SlidersHorizontal,
} from "lucide-preact";
import { requestHostPermission } from "../../src/core/permissions.ts";
import { applyDocumentLocale, applyLocale, formatRelativeTime, t } from "../../src/i18n.ts";
import { Banner, Card, Chip, Field, Icon, ListPicker, Logo, Row, Spinner } from "../../src/ui/components.tsx";
import "../../src/ui/styles.css";

/**
 * 选项页分四个选项卡。
 *
 * 之前是一长串卡片（设置、列表、覆盖、允许、WebDAV、迁移、诊断全堆在一页），
 * 找一项要滚很久；分组之后每屏只关心一件事。当前选项卡写进 URL hash，
 * 刷新与前进后退都不会跳回第一个。
 */
const TABS = ["general", "lists", "local", "data", "diagnostics"] as const;
type TabId = typeof TABS[number];

const TAB_LABELS: Record<TabId, string> = {
  general: "options.tab.general",
  lists: "options.tab.lists",
  local: "options.tab.local",
  data: "options.tab.data",
  diagnostics: "options.tab.diagnostics",
};

interface Loaded {
  config: ExtensionConfig;
  lists: ListSummary[];
  status: StatusResponse;
  overlay: OverlayRecord[];
  allowed: AllowRecord[];
}

function tabFromHash(): TabId {
  const raw = location.hash.replace(/^#/, "");
  return (TABS as readonly string[]).includes(raw) ? raw as TabId : "general";
}

function Options() {
  const [data, setData] = useState<Loaded | null>(null);
  // 只保留"失败"提示：动作成功的反馈在界面上本来就看得到（勾选框、条目数、下载的文件），
  // 再在选项卡下面弹一条"已订阅该列表"只是噪音。失败必须说，否则就是静默失败。
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const [diagnosis, setDiagnosis] = useState<DiagnoseResponse | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [importText, setImportText] = useState("");

  /**
   * 载入界面数据。
   *
   * 分两步，避免"打开页面必然要等一次网络往返"：
   * 1. 先把**本地数据**（配置、状态、本地覆盖、允许列表 —— 都来自 storage）渲染出来；
   * 2. 再取列表元数据 —— 默认吃后台的 30 分钟缓存，**不联网**；只有用户显式同步才强制拉取。
   */
  async function load(options: { forceLists?: boolean } = {}): Promise<void> {
    const [config, status, overlay, allowed] = await Promise.all([
      sendMessage<ConfigResponse>({ type: "getConfig" }),
      sendMessage<StatusResponse>({ type: "status" }),
      sendMessage<OverlayListResponse>({ type: "overlayList" }),
      sendMessage<AllowListResponse>({ type: "allowList" }),
    ]);
    applyLocale(config.config.locale);
    applyDocumentLocale("options.title");
    setData((previous) => ({
      config: config.config,
      // 列表可能稍后才到；先用上一次的，避免整页退回加载态。
      lists: previous?.lists ?? [],
      status,
      overlay: overlay.overlay,
      allowed: allowed.allowed,
    }));

    const lists = await sendMessage<ListsResponse>({
      type: "lists",
      force: options.forceLists === true,
    });
    setData((previous) => (previous ? { ...previous, lists: lists.lists } : previous));
  }

  useEffect(() => {
    void load().catch((error) => setErrorNotice(String(error)));
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /** 统一的写操作包装：置忙、刷新、只在失败时给提示。 */
  async function run(task: () => Promise<void>): Promise<void> {
    setBusy(true);
    setErrorNotice(null);
    try {
      await task();
      await load();
    } catch (error) {
      setErrorNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div style="max-width: 760px; margin: 0 auto; padding: 24px;">
        <h1 style="font-size: 22px;">{t("options.title")}</h1>
        <Spinner />
        {errorNotice && <Banner tone="error">{errorNotice}</Banner>}
      </div>
    );
  }

  const { config, lists, status, overlay, allowed } = data;
  const subscribed = new Set(config.subscriptions);

  const patchConfigValue = (patch: Partial<ExtensionConfig>) =>
    run(async () => {
      await sendMessage<ConfigResponse>({ type: "updateConfig", patch });
    });

  const setLocalConfig = (next: Partial<ExtensionConfig>) =>
    setData({ ...data, config: { ...config, ...next } });

  async function handleSyncNow(): Promise<void> {
    await run(async () => {
      const result = await sendMessage<SyncNowResponse>({ type: "syncNow", force: false });
      // 成功的反馈由「同步状态」行自己体现（条目数 + 最近同步时间）；有列表失败才要说话。
      if (result.errors.length > 0) throw new Error(t("options.syncFailedLists", { n: result.errors.length }));
      // 用户显式同步过：这时才值得强制刷新列表元数据。
      await load({ forceLists: true });
    });
  }

  async function handleToggleSubscription(listId: string, checked: boolean): Promise<void> {
    const next = checked
      ? [...config.subscriptions, listId]
      : config.subscriptions.filter((id) => id !== listId);
    await patchConfigValue({ subscriptions: next });
  }

  function handleWebdavSaveAndTest(): void {
    // 权限申请要在用户手势的同步路径上发起（见 permissions.ts 的说明），
    // 因此这里先拿到 Promise，再交给异步流程。
    const granted = config.webdav.url.trim().length > 0
      ? requestHostPermission(config.webdav.url)
      : Promise.resolve(true);
    void run(async () => {
      if (!(await granted)) throw new Error(t("options.webdav.noPermission", { url: config.webdav.url }));
      await sendMessage<ConfigResponse>({ type: "updateConfig", patch: { webdav: config.webdav } });
      const result = await sendMessage<WebdavResultResponse>({ type: "webdavTest" });
      if (!result.ok) throw new Error(result.message);
    });
  }

  async function handleWebdavSync(direction: "push" | "pull"): Promise<void> {
    await run(async () => {
      const result = await sendMessage<WebdavResultResponse>({ type: "webdavSync", direction });
      if (!result.ok) throw new Error(result.message);
    });
  }

  async function handleExport(): Promise<void> {
    await run(async () => {
      const content = await exportToFile(passphrase);
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `xlear-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    });
  }

  async function handleImport(): Promise<void> {
    await run(async () => {
      const result = await importFromFile(importText, passphrase);
      if (!result.ok) throw new Error(result.message);
    });
  }

  async function handleDiagnose(): Promise<void> {
    await run(async () => {
      setDiagnosis(await sendMessage<DiagnoseResponse>({ type: "diagnose" }));
    });
  }

  async function handleClearAll(): Promise<void> {
    await run(async () => {
      await sendMessage({ type: "clearAll" });
    });
  }

  return (
    <div style="max-width: 760px; margin: 0 auto; padding: 24px;">
      <header style="margin-bottom: 12px; display: flex; align-items: center; gap: 10px;">
        <Logo size={26} />
        <h1 style="font-size: 22px; margin: 0;">{t("options.title")}</h1>
      </header>

      <Tabs current={tab} onSelect={(id) => {
        setTab(id);
        location.hash = id;
      }} />

      {errorNotice && <Banner tone="error">{errorNotice}</Banner>}
      {status.lastSyncError && (
        <Banner tone="error">{t("options.lastSyncError", { error: status.lastSyncError })}</Banner>
      )}

      {tab === "general" && (
        <>
          <Card title={t("common.language")} icon={Globe}>
            <Field label={t("common.language")}>
              <select
                class="xl-select"
                value={config.locale}
                onChange={(event) => {
                  const locale = (event.target as HTMLSelectElement).value as LocaleSetting;
                  void run(async () => {
                    await sendMessage<ConfigResponse>({ type: "updateConfig", patch: { locale } });
                    applyLocale(locale);
                    applyDocumentLocale("options.title");
                  });
                }}
              >
                <option value="auto">Auto</option>
                <option value="en">English</option>
                <option value="zh">中文</option>
                <option value="ja">日本語</option>
                <option value="ru">Русский</option>
              </select>
            </Field>
          </Card>

          <Card title={t("options.syncStatus.title")} icon={RefreshCw}>
            <Row label={t("ext.lastSync")} hint={t("ext.localEntries")}>
              <span class="xl-muted">
                {status.entries.toLocaleString()} · {formatRelativeTime(status.lastSyncAt)}
              </span>
              <button
                class="xl-btn xl-btn-primary"
                type="button"
                disabled={busy}
                onClick={() => void handleSyncNow()}
              >
                <Icon icon={RefreshCw} size={15} />
                {t("ext.syncNow")}
              </button>
            </Row>
          </Card>
        </>
      )}

      {tab === "lists" && (
        <ListsPanel
          lists={lists}
          subscribed={subscribed}
          busy={busy}
          onChange={(id, checked) => void handleToggleSubscription(id, checked)}
          onCreated={() => void load()}
        />
      )}

      {tab === "local" && (
        <>
          <Card title={t("options.overlay.title")} subtitle={t("options.overlay.note")} icon={Inbox}>
            {overlay.length === 0
              ? <p class="xl-muted">{t("options.overlay.empty")}</p>
              : overlay.map((record) => (
                <AccountRow
                  key={record.userId}
                  screenName={record.screenName}
                  userId={record.userId}
                  button={t("options.overlay.remove")}
                  busy={busy}
                  onAction={() =>
                    void run(async () => {
                      await sendMessage({ type: "dropOverlay", userId: record.userId });
                    })}
                />
              ))}
          </Card>

          <Card title={t("options.allow.title")} subtitle={t("options.allow.note")} icon={ShieldOff}>
            {allowed.length === 0
              ? <p class="xl-muted">{t("options.allow.empty")}</p>
              : allowed.map((record) => (
                <AccountRow
                  key={record.userId}
                  screenName={record.screenName}
                  userId={record.userId}
                  button={t("options.allow.restore")}
                  busy={busy}
                  onAction={() =>
                    void run(async () => {
                      await sendMessage({ type: "unallow", userId: record.userId });
                    })}
                />
              ))}
          </Card>
        </>
      )}

      {tab === "data" && (
        <>
          <WebdavSection
            config={config}
            busy={busy}
            onLocalChange={(patch) => setLocalConfig(patch)}
            onSave={() => handleWebdavSaveAndTest()}
            onSync={(direction) => void handleWebdavSync(direction)}
          />

          <Card
            title={t("options.transfer.title")}
            subtitle={t("options.transfer.note")}
            icon={SlidersHorizontal}
          >
            <Field label={t("options.transfer.passphrase")}>
              <input
                class="xl-input"
                type="password"
                value={passphrase}
                onInput={(event) => setPassphrase((event.target as HTMLInputElement).value)}
              />
            </Field>
            <div style="margin-bottom: 12px;">
              <button
                class="xl-btn xl-btn-ghost"
                type="button"
                disabled={busy}
                onClick={() => void handleExport()}
              >
                {t("options.transfer.export")}
              </button>
            </div>
            <Field label={t("options.transfer.import")}>
              <textarea
                class="xl-textarea"
                rows={4}
                placeholder={t("options.transfer.importPlaceholder")}
                value={importText}
                onInput={(event) => setImportText((event.target as HTMLTextAreaElement).value)}
              />
            </Field>
            <button
              class="xl-btn xl-btn-ghost"
              type="button"
              disabled={busy || importText.trim().length === 0}
              onClick={() => void handleImport()}
            >
              {t("options.transfer.importButton")}
            </button>
          </Card>
        </>
      )}

      {tab === "diagnostics" && (
        <Card title={t("options.diagnostics.title")} subtitle={t("options.diagnostics.note")} icon={Settings2}>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
            <button class="xl-btn xl-btn-ghost" type="button" disabled={busy} onClick={() => void handleDiagnose()}>
              {t("options.diagnostics.run")}
            </button>
            <button class="xl-btn xl-btn-danger" type="button" disabled={busy} onClick={() => void handleClearAll()}>
              <Icon icon={Eraser} size={15} />
              {t("options.danger.clear")}
            </button>
          </div>
          {diagnosis && <DiagnoseList diagnosis={diagnosis} />}
        </Card>
      )}
    </div>
  );
}

/* ------------------------------ 选项卡 ------------------------------ */

function Tabs(props: { current: TabId; onSelect: (id: TabId) => void }) {
  return (
    <div
      style="display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px;"
      role="tablist"
    >
      {TABS.map((id) => {
        const active = props.current === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => props.onSelect(id)}
            style={{
              background: "none",
              border: "none",
              borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`,
              color: active ? "var(--text)" : "var(--muted)",
              padding: "8px 12px",
              marginBottom: "-1px",
              font: "inherit",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t(TAB_LABELS[id])}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------ 分区组件 ------------------------------ */

/**
 * 「本地覆盖」与「允许列表」共用的账号行。
 *
 * 两个列表以前各写了一遍，样式与信息都不一样：覆盖列表显示 @handle，允许列表只有一串数字 ID
 * （存储层当初只存了 userId），用户根本认不出是谁。现在统一成同一行、同一个 @handle 口径。
 */
function AccountRow(
  props: {
    screenName?: string;
    userId: string;
    button: string;
    busy: boolean;
    onAction: () => void;
  },
) {
  return (
    <Row label={`@${props.screenName ?? props.userId}`}>
      <button class="xl-btn xl-btn-ghost" type="button" disabled={props.busy} onClick={props.onAction}>
        {props.button}
      </button>
    </Row>
  );
}

/** 订阅列表页：卡片外壳 + 共用的选择器（选项页与欢迎页同一份实现）。 */
function ListsPanel(
  props: {
    lists: ListSummary[];
    subscribed: Set<string>;
    busy: boolean;
    onChange: (listId: string, checked: boolean) => void;
    onCreated: () => void;
  },
) {
  return (
    <Card title={t("options.lists.title")} subtitle={t("options.lists.note")} icon={ListChecks}>
      <ListPicker
        lists={props.lists}
        isSelected={(id) => props.subscribed.has(id)}
        onToggle={props.onChange}
        onCreated={props.onCreated}
        busy={props.busy}
        emptyText={t("options.lists.empty")}
      />
    </Card>
  );
}

function WebdavSection(
  props: {
    config: ExtensionConfig;
    busy: boolean;
    onLocalChange: (patch: Partial<ExtensionConfig>) => void;
    onSave: () => void;
    onSync: (direction: "push" | "pull") => void;
  },
) {
  const webdav = props.config.webdav;
  const setWebdav = (patch: Partial<ExtensionConfig["webdav"]>) =>
    props.onLocalChange({ webdav: { ...webdav, ...patch } });

  return (
    <Card title={t("options.webdav.title")} subtitle={t("options.webdav.note")}>
      <Field label={t("options.webdav.url")} hint={t("options.webdav.urlHint")}>
        <input
          class="xl-input"
          value={webdav.url}
          onInput={(event) => setWebdav({ url: (event.target as HTMLInputElement).value })}
        />
      </Field>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <Field label={t("options.webdav.username")}>
          <input
            class="xl-input"
            value={webdav.username}
            onInput={(event) => setWebdav({ username: (event.target as HTMLInputElement).value })}
          />
        </Field>
        <Field label={t("options.webdav.password")}>
          <input
            class="xl-input"
            type="password"
            value={webdav.password}
            onInput={(event) => setWebdav({ password: (event.target as HTMLInputElement).value })}
          />
        </Field>
      </div>
      <Field label={t("options.webdav.passphrase")} hint={t("options.webdav.passphraseHint")}>
        <input
          class="xl-input"
          type="password"
          value={webdav.passphrase}
          onInput={(event) => setWebdav({ passphrase: (event.target as HTMLInputElement).value })}
        />
      </Field>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button class="xl-btn xl-btn-ghost" type="button" disabled={props.busy} onClick={props.onSave}>
          {t("options.webdav.test")}
        </button>
        <button
          class="xl-btn xl-btn-primary"
          type="button"
          disabled={props.busy}
          onClick={() => props.onSync("push")}
        >
          {t("options.webdav.push")}
        </button>
        <button
          class="xl-btn xl-btn-ghost"
          type="button"
          disabled={props.busy}
          onClick={() => props.onSync("pull")}
        >
          {t("options.webdav.pull")}
        </button>
      </div>
    </Card>
  );
}

function DiagnoseList(props: { diagnosis: DiagnoseResponse }) {
  return (
    <div>
      <p class="xl-muted" style="margin: 0 0 8px;">
        {t("options.diagnostics.page", {
          url: props.diagnosis.url || t("options.diagnostics.noTab"),
        })}
      </p>
      {props.diagnosis.checks.map((check: DiagnoseCheck) => (
        <Row key={check.name} label={check.name} hint={check.detail}>
          {check.ok
            ? <Chip tone="success">{t("options.diagnostics.ok")}</Chip>
            : <Chip tone="danger">{t("options.diagnostics.missing")}</Chip>}
        </Row>
      ))}
    </div>
  );
}

render(<Options />, document.getElementById("app")!);
