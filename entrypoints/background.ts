/**
 * 后台（service worker / event page）。
 *
 * 它持有全部状态与网络请求：存储、同步、账号、举报队列。
 * 内容脚本与界面只能通过消息请求它，DOM 逻辑与业务逻辑因此互不纠缠。
 */
import { defineBackground } from "wxt/utils/define-background";
import { browser } from "wxt/browser";
import type { ListSummary, ReportSubmitResult } from "../shared/types.ts";
import { applyLocale, t } from "../src/i18n.ts";
import { fetchLists, submitCandidate } from "../src/core/api.ts";
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
  LocalListResponse,
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
  overlayCounts,
  overlayForList,
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
  await adoptOnlineLocalLists();
  await notifyXTabs();
  return { lists: result.lists, entries: result.totalEntries, errors: result.errors };
}

/**
 * 对账：本地列表的 id 一旦出现在服务端列表里，就说明管理员把它采纳成了在线列表。
 *
 * 此时本地那份记录退场（同一个 id 继续用，名称与理由改为服务端的版本），而条目**原样留在本地
 * 覆盖里** —— 也就是说用户在切换过程中感觉不到任何中断：还没被服务端复核出结论的账号，
 * 依然由本地覆盖顶着；复核出结论后，在线条目自然接管。
 */
async function adoptOnlineLocalLists(): Promise<void> {
  const config = await loadConfig();
  if (config.localLists.length === 0) return;
  const online = new Set((await getLists(true)).map((list) => list.id));
  const adopted = config.localLists.filter((list) => online.has(list.id));
  if (adopted.length === 0) return;
  await patchConfig({
    localLists: config.localLists.filter((list) => !online.has(list.id)),
  });
  // 逐条把原本地条目提交上线：没带帖子的（补字段之前建的）留在本地覆盖里，只对自己生效。
  for (const list of adopted) {
    const entries = await overlayForList(list.id);
    let submitted = 0;
    for (const entry of entries) {
      if (!entry.tweetId) continue;
      const results = await submitBlockReport(
        { userId: entry.userId, screenName: entry.screenName },
        [list.id],
        { id: entry.tweetId, url: entry.tweetUrl },
      );
      if (results.some((result) => result.status !== "queued")) submitted++;
    }
    console.info(
      `[xlear] 自建列表已在线：${list.name}（提交 ${submitted}/${entries.length} 条，其余只留本地）`,
    );
  }
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
      // 自建列表排在最前：那是用户自己的名单，先看到它才合理。
      const counts = await overlayCounts();
      const local: ListSummary[] = config.localLists.map((list) => ({
        id: list.id,
        name: list.name,
        reason: list.reason,
        entryCount: counts.get(list.id) ?? 0,
        subscriberCount: 0,
        version: 0,
      }));
      const response: ListsResponse = {
        lists: [...local, ...lists],
        subscriptions: config.subscriptions,
        locale: config.locale,
      };
      return response;
    }
    case "createLocalList": {
      const name = message.name.trim();
      const reason = message.reason.trim();
      if (name.length === 0 || reason.length === 0) {
        throw new Error("list name and reason are required");
      }
      // 列表在本地诞生：先落盘并订阅，条目立刻可用。上传只是收集，失败也不影响本地。
      const list = { id: crypto.randomUUID(), name, reason, createdAt: Date.now() };
      await patchConfig({
        localLists: [...config.localLists, list],
        subscriptions: config.subscriptions.includes(list.id)
          ? config.subscriptions
          : [...config.subscriptions, list.id],
      });
      void submitCandidate({
        id: list.id,
        name: list.name,
        reason: list.reason,
        ...(config.locale === "auto" ? {} : { locale: config.locale }),
      }).catch(() => undefined);
      return { id: list.id } satisfies LocalListResponse;
    }
    case "submitReport": {
      // 自建列表是用户自己的名单：条目只进本地覆盖、立刻生效，不出设备。
      const localIds = new Set(config.localLists.map((list) => list.id));
      const localTargets = message.listIds.filter((id) => localIds.has(id));
      const remoteTargets = message.listIds.filter((id) => !localIds.has(id));
      const results: ReportSubmitResult[] = [];
      if (localTargets.length > 0) {
        await addOverlay({
          userId: message.userId,
          screenName: message.screenName,
          lists: localTargets,
          addedAt: Date.now(),
          // 记下帖子：列表日后若被采纳，这条条目才有可复核的证据。
          tweetId: message.tweetId,
          tweetUrl: message.tweetUrl,
        });
        for (const listId of localTargets) results.push({ listId, status: "accepted" });
      }
      if (remoteTargets.length > 0) {
        results.push(...await submitBlockReport(
          { userId: message.userId, screenName: message.screenName },
          remoteTargets,
          { id: message.tweetId, url: message.tweetUrl, text: message.tweetText },
        ));
      }
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
