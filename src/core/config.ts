import { browser } from "wxt/browser";
import { type ExtensionConfig, normalizeConfig } from "./settings.ts";

/** 扩展侧配置的读写与归一化；形状与默认值在 `settings.ts`。 */

const CONFIG_KEY = "config";

/** 读取配置：把存储里的原始值交给 `normalizeConfig()` 补默认值与不变量。 */
export async function loadConfig(): Promise<ExtensionConfig> {
  const stored = await browser.storage.local.get(CONFIG_KEY);
  return normalizeConfig(stored[CONFIG_KEY]);
}

export async function saveConfig(config: ExtensionConfig): Promise<void> {
  await browser.storage.local.set({ [CONFIG_KEY]: config });
}

/** 改配置：合并补丁后过同一套归一化 —— 不变量与默认值只在一处维护。 */
export async function patchConfig(
  patch: Partial<ExtensionConfig>,
): Promise<ExtensionConfig> {
  const current = await loadConfig();
  const next = normalizeConfig({
    ...current,
    ...patch,
    webdav: { ...current.webdav, ...(patch.webdav ?? {}) },
  });
  await saveConfig(next);
  return next;
}

/** 运行期状态：同步水位、最近同步结果、今日隐藏的账号集合。 */
export interface RuntimeState {
  /** 每个列表已应用的版本号与最近同步时间。 */
  listVersions: Record<
    string,
    { version: number; lastSyncAt: number; entries: number }
  >;
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
    const current = state.counters.day === day
      ? state.counters.hiddenAccounts
      : [];
    const merged = [...new Set([...current, ...userIds])].slice(
      -HIDDEN_ACCOUNTS_CAP,
    );
    return { counters: { day, hiddenAccounts: merged } };
  });
}
