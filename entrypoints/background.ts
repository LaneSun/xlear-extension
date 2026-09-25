/**
 * 后台（service worker / event page）。
 *
 * 它持有全部状态与网络请求：存储、同步、账号、举报队列。
 * 内容脚本与界面只能通过消息请求它，DOM 逻辑与业务逻辑因此互不纠缠。
 */
import { defineBackground } from "wxt/utils/define-background";
import { browser } from "wxt/browser";
import type { ListSummary } from "../shared/types.ts";
import { applyLocale, t } from "../src/i18n.ts";
import { fetchLists } from "../src/core/api.ts";
import {
  bumpHidden,
  loadAccountKey,
  loadConfig,
  loadState,
  mutateState,
  patchConfig,
  todayKey,
} from "../src/core/config.ts";
import type {
  DiagnoseResponse,
  AllowListResponse,
  ConfigResponse,
  ExtensionMessage,
  ListsResponse,
  MatchResponse,
  OverlayListResponse,
  OutboxListResponse,
  StatusResponse,
  SubmitResponse,
  WebdavResultResponse,
} from "../src/core/messaging.ts";
import { flushOutbox, outboxSize, submitBlockReport } from "../src/core/reports.ts";
import {
  addOverlay,
  allowUser,
  clearAll,
  countFiltered,
  countOverlay,
  disallowUser,
  dropList,
  listAllowed,
  listOverlay,
  listReportQueue,
  matchUsers,
  removeOverlay,
} from "../src/core/storage.ts";
import { syncAll } from "../src/core/sync.ts";
import { pullFromWebdav, pushToWebdav, testWebdav } from "../src/sync/webdav.ts";

const SYNC_ALARM = "xlear-sync";
const OUTBOX_ALARM = "xlear-outbox";
const SYNC_PERIOD_MINUTES = 24 * 60;

let listsCache: { at: number; lists: ListSummary[] } | null = null;

export default defineBackground(() => {
  console.log("[xlear] 后台已启动");

  const scheduleAlarms = async () => {
    const config = await loadConfig();
    // 定时同步在后台自行发起，语言要先对齐配置（界面开关不会唤醒这段代码）。
    applyLocale(config.locale);
    await applySyncAlarm(config.subscriptions.length > 0);
    await browser.alarms.create(OUTBOX_ALARM, { periodInMinutes: 15, delayInMinutes: 2 });
  };

  browser.runtime.onInstalled.addListener((details) => {
    void scheduleAlarms();
    if (details.reason === "install") {
      void browser.tabs.create({ url: "/onboarding.html" });
    }
  });
  browser.runtime.onStartup.addListener(() => void scheduleAlarms());
  void scheduleAlarms();

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) {
      void runSync().catch((error) => console.warn("[xlear] 定时同步失败", error));
    }
    if (alarm.name === OUTBOX_ALARM) {
      void flushOutbox().catch(() => {});
    }
  });

  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    void handleMessage(message as ExtensionMessage)
      .then((response) => sendResponse(response))
      .catch((error) => {
        console.warn("[xlear] 消息处理失败", error);
        sendResponse({ error: error instanceof Error ? error.message : String(error) });
      });
    return true; // 异步响应
  });
});

/** 没有订阅就不要留着定时同步的告警（退订后它只会空转）。 */
async function applySyncAlarm(hasSubscriptions: boolean): Promise<void> {
  if (hasSubscriptions) {
    await browser.alarms.create(SYNC_ALARM, {
      periodInMinutes: SYNC_PERIOD_MINUTES,
      delayInMinutes: 1,
    });
  } else {
    await browser.alarms.clear(SYNC_ALARM);
  }
}

/** 让已打开的 X 标签页立刻按新的本地状态重算隐藏（订阅、语言、本地覆盖都会变）。 */
async function notifyXTabs(): Promise<void> {
  try {
    const tabs = await browser.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      await browser.tabs.sendMessage(tab.id, { type: "refresh" }).catch(() => {});
    }
  } catch {
    // 没有打开的标签页是正常情况。
  }
}

/** 列表目录缓存半小时，理由弹窗要用。 */
async function getLists(force = false): Promise<ListSummary[]> {
  if (!force && listsCache && Date.now() - listsCache.at < 30 * 60_000) return listsCache.lists;
  try {
    const response = await fetchLists();
    listsCache = { at: Date.now(), lists: response.lists };
    return response.lists;
  } catch (error) {
    // 有缓存就先用缓存（离线时理由弹窗仍能列出订阅的列表）；
    // 没有缓存就把错误抛出去 —— 一律返回 [] 会让首启页把"连不上服务端"
    // 显示成"已连接，但服务端还没有启用中的列表"。
    if (listsCache) return listsCache.lists;
    throw error;
  }
}

async function runSync(force = false): Promise<{ lists: number; entries: number; errors: string[] }> {
  const config = await loadConfig();
  const result = await syncAll(config, { force });
  await notifyXTabs();
  return { lists: result.lists, entries: result.totalEntries, errors: result.errors };
}

async function buildStatus(): Promise<StatusResponse> {
  const config = await loadConfig();
  const state = await loadState();
  const [entries, overlay, key, outbox] = await Promise.all([
    countFiltered(),
    countOverlay(),
    loadAccountKey(),
    outboxSize(),
  ]);
  return {
    enabled: config.enabled,
    lastSyncAt: state.lastSyncAt,
    lastSyncError: state.lastSyncError,
    entries,
    overlay,
    counters: state.counters,
    outbox,
    hasAccount: key !== null,
  };
}

/** 在打开的 X 标签页里跑一次选择器自检。 */
async function diagnose(): Promise<DiagnoseResponse> {
  try {
    const tabs = await browser.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
    const tab = tabs.find((candidate) => candidate.id !== undefined);
    if (!tab || tab.id === undefined) {
      return {
        url: "",
        checks: [
          {
            name: t("ext.diagnostics.tab"),
            ok: false,
            detail: t("ext.diagnostics.openTab"),
          },
        ],
      };
    }
    const response = await browser.tabs.sendMessage(tab.id, { type: "xlearDiagnose" }) as DiagnoseResponse | undefined;
    return response ?? {
      url: tab.url ?? "",
      checks: [
        { name: t("ext.diagnostics.contentScript"), ok: false, detail: t("ext.diagnostics.noResponse") },
      ],
    };
  } catch (error) {
    return {
      url: "",
      checks: [
        {
          name: t("ext.diagnostics.contentScript"),
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

async function handleMessage(message: ExtensionMessage): Promise<unknown> {
  const config = await loadConfig();
  // 后台返回给界面的错误与跳过原因都要用当前语言，先对齐语言再处理消息。
  applyLocale(config.locale);
  switch (message.type) {
    case "match": {
      // 总开关在后台生效：关掉时一律返回"没有命中"，内容脚本据此不隐藏任何帖子。
      const matches = config.enabled ? await matchUsers(message.userIds) : new Map();
      const response: MatchResponse = {
        matches: [...matches.entries()].map(([userId, info]) => ({
          userId,
          lists: info.lists,
        })),
      };
      return response;
    }
    case "lists": {
      const lists = await getLists(message.force);
      const response: ListsResponse = {
        lists,
        subscriptions: config.subscriptions,
        locale: config.locale,
      };
      return response;
    }
    case "submitReport": {
      const results = await submitBlockReport(
        { userId: message.userId, screenName: message.screenName },
        message.listIds,
        { id: message.tweetId, url: message.tweetUrl, text: message.tweetText },
      );
      const response: SubmitResponse = { results };
      return response;
    }
    case "addOverlay": {
      await addOverlay({
        userId: message.userId,
        screenName: message.screenName,
        lists: message.listIds,
        addedAt: Date.now(),
      });
      await notifyXTabs();
      return { ok: true };
    }
    case "allow": {
      await allowUser(message.userId, message.screenName);
      await notifyXTabs();
      return { ok: true };
    }
    case "countHidden": {
      await bumpHidden(message.userIds);
      return { ok: true };
    }
    case "status":
      return await buildStatus();
    case "getConfig": {
      const response: ConfigResponse = { config };
      return response;
    }
    case "diagnose":
      return await diagnose();
    case "syncNow":
      return await runSync(message.force);
    case "updateConfig": {
      const next = await patchConfig(message.patch);
      // 列表名与理由是按请求语言取的，语言一变缓存立刻作废，否则屏蔽弹窗会混语言。
      if (next.locale !== config.locale) listsCache = null;
      // 退订的列表要把本地条目一起清掉，否则会"退订了还在过滤"。
      const removed = config.subscriptions.filter((id) => !next.subscriptions.includes(id));
      for (const listId of removed) await dropList(listId);
      await applySyncAlarm(next.subscriptions.length > 0);
      // 已打开的 X 标签页要立刻换语言/换订阅，不必等下一次同步或刷新页面。
      await notifyXTabs();
      const response: ConfigResponse = { config: next };
      return response;
    }
    case "flushOutbox":
      return { results: await flushOutbox() };
    case "overlayList": {
      const response: OverlayListResponse = { overlay: await listOverlay() };
      return response;
    }
    case "dropOverlay": {
      await removeOverlay(message.userId);
      await notifyXTabs();
      return { ok: true };
    }
    case "allowList": {
      const response: AllowListResponse = { allowed: await listAllowed() };
      return response;
    }
    case "unallow": {
      await disallowUser(message.userId);
      await notifyXTabs();
      return { ok: true };
    }
    case "outboxList": {
      const response: OutboxListResponse = { outbox: await listReportQueue() };
      return response;
    }
    case "webdavTest": {
      const response: WebdavResultResponse = await testWebdav(config);
      return response;
    }
    case "webdavSync": {
      const response: WebdavResultResponse = message.direction === "push"
        ? await pushToWebdav(config)
        : await pullFromWebdav(config);
      return response;
    }
    case "clearAll": {
      await clearAll();
      // 版本水位必须一起清掉，否则重新订阅同一列表时增量同步会从旧版本继续，
      // 导致本地是空的、却以为已经同步过。
      await mutateState(() => ({
        listVersions: {},
        lastSyncAt: 0,
        lastSyncError: undefined,
        counters: { day: todayKey(), hiddenAccounts: [] },
      }));
      await notifyXTabs();
      return { ok: true };
    }
    default: {
      // 穷尽检查：消息类型有新增时这里会编译不过，避免悄悄落进"成功"分支。
      const unknown: never = message;
      return { error: `Unknown message: ${JSON.stringify(unknown)}` };
    }
  }
}
