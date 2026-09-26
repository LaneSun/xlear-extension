import type { LocalListRow } from "../../src/core/messaging.ts";
import { render } from "preact";
import { browser } from "wxt/browser";
import { useEffect, useState } from "preact/hooks";
import type { ListSummary } from "../../shared/types.ts";
import type {
  ConfigResponse,
  ListsResponse,
  OverlayListResponse,
  SyncNowResponse,
} from "../../src/core/messaging.ts";
import { sendMessage } from "../../src/core/messaging.ts";
import {
  hasRequiredOrigins,
  requestRequiredOrigins,
} from "../../src/core/permissions.ts";
import { ListChecks, Server, ShieldCheck } from "lucide-preact";
import { applyDocumentLocale, applyLocale, t } from "../../src/i18n.ts";
import {
  Banner,
  Card,
  ListPicker,
  LocalListsPanel,
  Logo,
  Spinner,
} from "../../src/ui/components.tsx";
import "../../src/ui/styles.css";

type Stage =
  | "connecting"
  | "needs-permission"
  | "choosing"
  | "syncing"
  | "done";

function Onboarding() {
  const [stage, setStage] = useState<Stage>("connecting");
  const [lists, setLists] = useState<ListSummary[]>([]);
  const [local, setLocal] = useState<LocalListRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<
    { tone: "info" | "error" | "success"; text: string } | null
  >(null);
  const [summary, setSummary] = useState("");

  useEffect(() => {
    void bootstrap();
  }, []);

  /** 读配置 → 检查域名权限 → 有权限就直接拉列表。 */
  async function bootstrap(): Promise<void> {
    try {
      const response = await sendMessage<ConfigResponse>({ type: "getConfig" });
      applyLocale(response.config.locale);
      applyDocumentLocale("onboarding.welcome");
      if (await hasRequiredOrigins()) {
        await loadLists();
      } else {
        setStage("needs-permission");
      }
    } catch (error) {
      setNotice({ tone: "error", text: String(error) });
      setStage("needs-permission");
    }
  }

  /** `granted` 已经在点击处理函数里同步发起（Firefox 的手势要求），这里只等结果。 */
  async function connect(granted: Promise<boolean>): Promise<void> {
    setNotice(null);
    try {
      if (!(await granted)) {
        setNotice({ tone: "error", text: t("onboarding.connect.denied") });
        return;
      }
      await loadLists();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 本地列表变动后的刷新：重新取一次 lists 并同时更新两组状态。
   *
   * 不复用 loadLists() —— 它还负责 stage 切换等首启流程，复用它会把流程副作用带进来；
   * 这里只关心"数据变了，界面跟上"。
   */
  async function refreshLists(): Promise<void> {
    const response = await sendMessage<ListsResponse>({
      type: "lists",
      force: true,
    });
    setLists(response.lists);
    setLocal(response.local ?? []);
  }

  async function loadLists(): Promise<void> {
    try {
      const response = await sendMessage<ListsResponse>({
        type: "lists",
        force: true,
      });
      setLists(response.lists);
      setLocal(response.local ?? []);
      // 刻意不预选任何列表：订阅哪些由用户自己决定（原来会默认勾选活跃度最高的两个）。
      setStage("choosing");
      if (response.lists.length === 0) {
        setNotice({ tone: "info", text: t("onboarding.connect.empty") });
      }
    } catch (error) {
      setNotice({
        tone: "error",
        text: t("onboarding.connect.loadFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      });
      setStage("needs-permission");
    }
  }

  async function finish(): Promise<void> {
    setStage("syncing");
    setNotice(null);
    try {
      await sendMessage<ConfigResponse>({
        type: "updateConfig",
        patch: { subscriptions: selected },
      });
      const result = await sendMessage<SyncNowResponse>({
        type: "syncNow",
        force: true,
      });
      const failed = result.errors.length > 0
        ? t("onboarding.done.failedLists", { n: result.errors.length })
        : "";
      setSummary(
        t("onboarding.done.summary", {
          n: result.entries.toLocaleString(),
          failed,
        }),
      );
      setStage("done");
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      setStage("choosing");
    }
  }

  return (
    <div style="max-width: 680px; margin: 0 auto; padding: 32px;">
      <h1 style="font-size: 24px; margin-bottom: 4px; display: flex; align-items: center; gap: 8px;">
        <Logo size={24} />
        {t("onboarding.welcome")}
      </h1>
      {
        /* Tailwind 的 preflight 会把 p 的默认边距清零，这里必须显式写下边距，
          否则这段文字会紧贴下面的卡片（只隔一层卡片边框）。 */
      }
      <p class="xl-muted" style="margin: 0 0 16px;">
        {t("onboarding.intro")}
      </p>
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}

      {(stage === "connecting") && <Spinner />}

      {stage === "needs-permission" && (
        <Card
          title={t("onboarding.connect.title")}
          subtitle={t("onboarding.connect.note")}
          icon={Server}
        >
          <button
            class="xl-btn xl-btn-primary"
            type="button"
            onClick={() => {
              // 地址是固定的（src/core/server.ts）；这里一次把服务端与 X 的访问权限都要下来。
              // Firefox 要求 permissions.request 处在用户输入的同步路径上，因此先把它发出去，
              // 再交给异步流程 —— 任何 await 都必须排在这一行之后。
              void connect(requestRequiredOrigins());
            }}
          >
            {t("onboarding.connect.button")}
          </button>
        </Card>
      )}

      {stage === "choosing" && (
        <>
          <LocalListsPanel
            rows={local}
            onCreate={async (name, reason) => {
              await sendMessage({ type: "createLocalList", name, reason });
              await refreshLists();
            }}
            onRename={async (id, name, reason) => {
              await sendMessage({ type: "renameLocalList", id, name, reason });
              await refreshLists();
            }}
            onDelete={async (id) => {
              await sendMessage({ type: "deleteLocalList", id });
              await refreshLists();
            }}
            onToggle={async (id, enabled) => {
              await sendMessage({ type: "setLocalListEnabled", id, enabled });
              await refreshLists();
            }}
            entries={{
              load: async (listId) => {
                const response = await sendMessage<OverlayListResponse>({
                  type: "overlayList",
                });
                return response.overlay
                  .filter((record) => record.lists.includes(listId))
                  .map((record) => ({
                    userId: record.userId,
                    screenName: record.screenName,
                    tweetUrl: record.tweetUrl,
                  }));
              },
              remove: async (listId, userId) => {
                await sendMessage({ type: "dropOverlay", userId, listId });
                // 行上的"条目数"来自页面数据，移除之后要一起刷新。
                await refreshLists();
              },
            }}
          />
          <Card
            title={t("onboarding.choose.title")}
            subtitle={t("onboarding.choose.note")}
            icon={ListChecks}
          >
            <ListPicker
              lists={lists}
              isSelected={(id) => selected.includes(id)}
              onToggle={(id, checked) =>
                setSelected(
                  checked
                    ? [...selected, id]
                    : selected.filter((item) => item !== id),
                )}
              emptyText={t("onboarding.choose.empty")}
            />
          </Card>

          <button
            class="xl-btn xl-btn-primary"
            type="button"
            disabled={selected.length === 0}
            onClick={() => void finish()}
          >
            {t("onboarding.start")}
          </button>
        </>
      )}

      {stage === "syncing" && <Spinner label={t("onboarding.syncing")} />}

      {stage === "done" && (
        <>
          <Banner tone="success">{summary}</Banner>
          <Card title={t("onboarding.next.title")} icon={ShieldCheck}>
            <ul style="margin: 0; padding-left: 20px; line-height: 1.9;">
              <li>{t("onboarding.next.1")}</li>
              <li>{t("onboarding.next.2")}</li>
            </ul>
          </Card>
          <button
            class="xl-btn xl-btn-primary"
            type="button"
            onClick={() => void browser.runtime.openOptionsPage()}
          >
            {t("onboarding.openOptions")}
          </button>
        </>
      )}
    </div>
  );
}

render(<Onboarding />, document.getElementById("app")!);
