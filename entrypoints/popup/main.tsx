import { render } from "preact";
import { browser } from "wxt/browser";
import { useEffect, useState } from "preact/hooks";
import type { ConfigResponse, StatusResponse } from "../../src/core/messaging.ts";
import { sendMessage } from "../../src/core/messaging.ts";
import { requestServerPermission } from "../../src/core/permissions.ts";
import { SERVER_URL } from "../../src/core/server.ts";
import { CircleAlert, EyeOff, Inbox, ListChecks, RefreshCw, Settings } from "lucide-preact";
import { applyDocumentLocale, applyLocale, formatRelativeTime, localeSignal, t } from "../../src/i18n.ts";
import { Banner, Card, Icon, Logo, Row, Spinner } from "../../src/ui/components.tsx";
import "../../src/ui/styles.css";

function Popup() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // 读一下语言信号，切换语言时整页重渲染。
  void localeSignal.value;

  const refresh = async () => {
    try {
      setStatus(await sendMessage<StatusResponse>({ type: "status" }));
    } catch {
      setMessage({ tone: "error", text: t("ext.backendNotReady") });
    }
  };

  useEffect(() => {
    void sendMessage<ConfigResponse>({ type: "getConfig" })
      .then((response) => {
        applyLocale(response.config.locale);
        applyDocumentLocale("ext.popupTitle");
      })
      .finally(() => void refresh());
  }, []);

  async function withBusy(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      if (done) setMessage({ tone: "info", text: done });
      await refresh();
    } catch (error) {
      setMessage({
        tone: "error",
        text: t("common.networkError", {
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <div style="min-width: 300px; max-width: 460px; width: 100%; margin: 0 auto; padding: 16px;">
        <strong style="font-size: 18px; display: inline-flex; align-items: center; gap: 7px;">
          <Logo size={20} />
          Xlear
        </strong>
        <div style="margin-top: 8px;"><Spinner label={t("common.loading")} /></div>
        {message && <Banner tone={message.tone}>{message.text}</Banner>}
      </div>
    );
  }

  return (
    <div style="min-width: 300px; max-width: 460px; width: 100%; margin: 0 auto; padding: 16px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
        <strong style="font-size: 18px; display: inline-flex; align-items: center; gap: 7px;">
          <Logo size={20} />
          Xlear
        </strong>
        {/* 总开关就放在原来"运行中"的位置：开关本身表示状态，不写解释文案。 */}
        <input
          class="xl-switch"
          type="checkbox"
          aria-label={t("ext.masterSwitch")}
          checked={status.enabled}
          disabled={busy}
          onChange={(event) =>
            void withBusy(() =>
              sendMessage({
                type: "updateConfig",
                patch: { enabled: (event.target as HTMLInputElement).checked },
              })
            )}
        />
      </div>

      {message && <Banner tone={message.tone}>{message.text}</Banner>}
      {status.lastSyncError && (
        <Banner tone="error">{t("ext.syncError", { error: status.lastSyncError })}</Banner>
      )}
      <Card>
        <Row label={t("ext.localEntries")} icon={ListChecks}>
          <strong>{status.entries.toLocaleString()}</strong>
        </Row>
        <Row label={t("ext.overlay")} icon={Inbox}>
          <strong>{status.overlay.toLocaleString()}</strong>
        </Row>
        <Row icon={EyeOff} label={t("ext.hiddenToday")}>
          <strong>{status.counters.hiddenAccounts.length.toLocaleString()}</strong>
        </Row>
        <Row label={t("ext.lastSync")}>
          <span class="xl-muted">{formatRelativeTime(status.lastSyncAt)}</span>
        </Row>
        {status.outbox > 0 && (
          <Row label={t("ext.outbox")} icon={CircleAlert}>
            <span class="xl-chip xl-chip-danger">{status.outbox}</span>
          </Row>
        )}
      </Card>

      <div style="display: flex; gap: 8px;">
          <button
            class="xl-btn xl-btn-primary"
            type="button"
            disabled={busy}
            onClick={() => {
              // 同首启页：request 必须先于任何 await（Firefox 的手势检查）。
              const granted = requestServerPermission();
              void withBusy(async () => {
                if (!(await granted)) throw new Error(t("ext.needPermission"));
                return await sendMessage({ type: "syncNow" });
              }, t("ext.syncDone"));
            }}
          >
            <Icon icon={RefreshCw} size={15} />
            {busy ? t("ext.syncing") : t("ext.syncNow")}
          </button>
          <button
            class="xl-btn xl-btn-ghost"
            type="button"
            disabled={busy}
            onClick={() => void browser.runtime.openOptionsPage()}
          >
            <Icon icon={Settings} size={15} />
            {t("ext.options")}
          </button>
      </div>

      <div style="display: flex; justify-content: space-between; font-size: 12px; margin-top: 12px;">
        <a class="xl-muted" href={`${SERVER_URL}/status`} target="_blank" rel="noreferrer">
          {t("ext.transparency")}
        </a>
        <a class="xl-muted" href={`${SERVER_URL}/search`} target="_blank" rel="noreferrer">
          {t("ext.lookup")}
        </a>
      </div>
    </div>
  );
}

render(<Popup />, document.getElementById("app")!);
