import { browser } from "wxt/browser";
/** 扩展侧的配置：存储形态、默认值与读写。 */

/** 界面语言：auto 跟随浏览器，其余是受支持的语言代码。 */
export type LocaleSetting = "auto" | "en" | "zh" | "ja" | "ru";

/**
 * 用户自己建的列表。
 *
 * 它首先是**用户自己的名单**：创建即在本机可用、可订阅、可举报，条目不出设备。
 * 名称与理由会交一份给服务端留作记录（平台据此收集，是否发展成在线列表由管理员决定），
 * 这件事不改变它在本地的工作方式。
 */
export interface LocalList {
  /** 客户端生成的 UUID；若日后被采纳为在线列表，沿用的就是它。 */
  id: string;
  /** 用户自己写的名称，原文，不做多语言化。 */
  name: string;
  /** 用户自己写的理由，原文。 */
  reason: string;
  createdAt: number;
}

export interface ExtensionConfig {
  /** 已订阅的列表 ID。 */
  subscriptions: string[];
  /** 总开关。 */
  enabled: boolean;
  /** 界面语言，默认跟随浏览器。 */
  locale: LocaleSetting;
  /** 用户自建的本地列表。 */
  localLists: LocalList[];
  /** WebDAV 配置。 */
  webdav: {
    enabled: boolean;
    url: string;
    username: string;
    password: string;
    /** 加密口令；为空表示明文上传。 */
    passphrase: string;
  };
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  subscriptions: [],
  localLists: [],
  enabled: true,
  locale: "auto",
  webdav: { enabled: false, url: "", username: "", password: "", passphrase: "" },
};

const CONFIG_KEY = "config";

/**
 * 读取配置：缺失字段用默认值补齐，**并且只保留当前定义里的键**。
 *
 * 选项会随版本增删，删掉的键如果继续跟着 spread 走，就会一直留在存储里、
 * 跟着导出文件与 WebDAV 同步漂到别的设备上。这里按默认值的键集重建一份干净的配置。
 */
export async function loadConfig(): Promise<ExtensionConfig> {
  const stored = await browser.storage.local.get(CONFIG_KEY);
  const raw = (stored[CONFIG_KEY] ?? {}) as Partial<ExtensionConfig>;
  const config: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = (raw as Record<string, unknown>)[key];
    if (value !== undefined) config[key] = value;
  }
  return {
    ...(config as unknown as ExtensionConfig),
    webdav: { ...DEFAULT_CONFIG.webdav, ...(raw.webdav ?? {}) },
    subscriptions: [...new Set(raw.subscriptions ?? [])],
    localLists: normalizeLocalLists(raw.localLists),
  };
}

/** 本地列表只保留形状正确的记录：存储可能来自旧版本或被手工改过。 */
function normalizeLocalLists(raw: unknown): LocalList[] {
  if (!Array.isArray(raw)) return [];
  const lists: LocalList[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { id, name, reason, createdAt } = item as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof name !== "string" || typeof reason !== "string") continue;
    lists.push({ id, name, reason, createdAt: Number(createdAt) || Date.now() });
  }
  return lists;
}

export async function saveConfig(config: ExtensionConfig): Promise<void> {
  await browser.storage.local.set({ [CONFIG_KEY]: config });
}

export async function patchConfig(patch: Partial<ExtensionConfig>): Promise<ExtensionConfig> {
  const current = await loadConfig();
  const next: ExtensionConfig = {
    ...current,
    ...patch,
    webdav: { ...current.webdav, ...(patch.webdav ?? {}) },
    subscriptions: patch.subscriptions
      ? [...new Set(patch.subscriptions)]
      : current.subscriptions,
    localLists: patch.localLists ?? current.localLists,
  };
  await saveConfig(next);
  return next;
}

/** 运行期状态：同步水位、最近同步结果、今日隐藏的账号集合。 */
export interface RuntimeState {
  /** 每个列表已应用的版本号与最近同步时间。 */
  listVersions: Record<string, { version: number; lastSyncAt: number; entries: number }>;
  lastSyncAt: number;
  lastSyncError?: string;
  /**
   * 按天统计"被隐藏的账号"。
   *
   * 记的是账号集合而不是隐藏动作次数：X 的时间线会不断重建节点，同一条帖子重新出现就
   * 会让"次数"再涨一次（同一账号反复出现会被重复计数）。集合同时天然
   * 做到跨页面去重，口径也与条目/账号的展示单位一致。
   */
  counters: { day: string; hiddenAccounts: string[] };
}

/** 账号集合的上限：防御性封顶，避免状态无界增长。 */
const HIDDEN_ACCOUNTS_CAP = 2000;

const STATE_KEY = "runtime";

export function todayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function loadState(): Promise<RuntimeState> {
  const stored = await browser.storage.local.get(STATE_KEY);
  const raw = (stored[STATE_KEY] ?? {}) as Partial<RuntimeState>;
  const day = todayKey();
  const counters = raw.counters?.day === day
    ? { day, hiddenAccounts: (raw.counters.hiddenAccounts ?? []).map(String) }
    : { day, hiddenAccounts: [] };
  return {
    listVersions: raw.listVersions ?? {},
    lastSyncAt: raw.lastSyncAt ?? 0,
    lastSyncError: raw.lastSyncError,
    counters,
  };
}

export async function saveState(state: RuntimeState): Promise<void> {
  await browser.storage.local.set({ [STATE_KEY]: state });
}

/**
 * 串行化对运行期状态的读改写。
 *
 * 状态是一个整体对象，若两个操作各自"读-改-写"，后写的会覆盖先写的结果
 * （清空数据与隐藏计数的并发写入会互相覆盖）。service worker 是单线程的，
 * 用一个 Promise 队列把读改写串起来即可彻底消除这类竞争。
 */
let stateQueue: Promise<unknown> = Promise.resolve();

export function mutateState(
  mutate: (state: RuntimeState) => Partial<RuntimeState>,
): Promise<RuntimeState> {
  const run = async (): Promise<RuntimeState> => {
    const current = await loadState();
    const next: RuntimeState = { ...current, ...mutate(current) };
    await saveState(next);
    return next;
  };
  const result = stateQueue.then(run, run);
  stateQueue = result.catch(() => {});
  return result;
}

/** 账号密钥存放位置。与配置分开，便于导出时单独处理。 */
const KEY_STORAGE = "accountKey";

export async function loadAccountKey(): Promise<string | null> {
  const stored = await browser.storage.local.get(KEY_STORAGE);
  const value = stored[KEY_STORAGE];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function saveAccountKey(key: string): Promise<void> {
  await browser.storage.local.set({ [KEY_STORAGE]: key });
}

export async function clearAccountKey(): Promise<void> {
  await browser.storage.local.remove(KEY_STORAGE);
}

/** 记录今天隐藏了哪些账号（内容脚本按批上报，同账号重复出现只算一次）。 */
export async function bumpHidden(userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await mutateState((state) => {
    const day = todayKey();
    const current = state.counters.day === day ? state.counters.hiddenAccounts : [];
    const merged = [...new Set([...current, ...userIds])].slice(-HIDDEN_ACCOUNTS_CAP);
    return { counters: { day, hiddenAccounts: merged } };
  });
}
