/**
 * 本地存储。
 *
 * 过滤条目可能有几十万条，`storage.local` 的容量撑不住，因此集合类数据放 IndexedDB：
 * - `filtered`：来自订阅列表的条目，按账号 ID 建主键，另按列表建多值索引以便退订时清理；
 * - `overlay`：用户提交后立刻生效的本地覆盖（平台尚未审核）；
 * - `allow`：用户手动「仍然显示」的账号，优先级最高；
 * - `outbox`：提交失败待重试的举报。
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface FilteredRecord {
  userId: string;
  /** 差量里带着 @handle，存下来列表/卡片才能显示成人看得懂的名字。 */
  screenName?: string;
  lists: string[];
  at: number;
}

/** 允许列表里的一条记录（不再隐藏某个账号）。 */
export interface AllowRecord {
  userId: string;
  /** 没有名字的历史记录会从本地库补齐；补不到就只显示 ID。 */
  screenName?: string;
  at: number;
}

export interface OverlayRecord {
  userId: string;
  screenName?: string;
  lists: string[];
  addedAt: number;
  /**
   * 用户点屏蔽时所在的那条帖子。
   *
   * 本地列表只要账号就够用，但采纳成在线列表后要按举报契约复核 —— 举报的证据是**帖子**，
   * 所以这两项必须一起留下来。补上之前建的条目没有它们，就永远只做本地覆盖（不上传）。
   */
  tweetId?: string;
  tweetUrl?: string;
}

export interface OutboxRecord {
  id?: number;
  listId: string;
  userId: string;
  screenName?: string;
  tweetId: string;
  tweetUrl?: string;
  tweetText?: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

interface XlearDB extends DBSchema {
  filtered: {
    key: string;
    value: FilteredRecord;
    indexes: { byList: string };
  };
  overlay: {
    key: string;
    value: OverlayRecord;
  };
  allow: {
    key: string;
    value: AllowRecord;
  };
  outbox: {
    key: number;
    value: OutboxRecord;
    indexes: { byCreated: number };
  };
}

const DB_NAME = "xlear";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<XlearDB>> | null = null;

function db(): Promise<IDBPDatabase<XlearDB>> {
  if (!dbPromise) {
    dbPromise = openDB<XlearDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        const filtered = database.createObjectStore("filtered", { keyPath: "userId" });
        filtered.createIndex("byList", "lists", { multiEntry: true });
        database.createObjectStore("overlay", { keyPath: "userId" });
        database.createObjectStore("allow", { keyPath: "userId" });
        const outbox = database.createObjectStore("outbox", {
          keyPath: "id",
          autoIncrement: true,
        });
        outbox.createIndex("byCreated", "createdAt");
      },
    });
  }
  return dbPromise;
}

/** 批量判断账号是否命中过滤库。返回的 Map 只包含命中的账号。 */
export async function matchUsers(
  userIds: readonly string[],
): Promise<Map<string, { lists: string[] }>> {
  const result = new Map<string, { lists: string[] }>();
  if (userIds.length === 0) return result;
  const database = await db();
  // idb 的 getAll 不接受键数组，用并行单点读取（每批通常只有几十个 ID）。
  const [filtered, overlay, allowed] = await Promise.all([
    Promise.all(userIds.map((id) => database.get("filtered", id))),
    Promise.all(userIds.map((id) => database.get("overlay", id))),
    Promise.all(userIds.map((id) => database.get("allow", id))),
  ]);
  const allowedIds = new Set(
    allowed.filter((record) => record !== undefined).map((record) => record.userId),
  );
  for (const record of filtered) {
    if (!record || allowedIds.has(record.userId)) continue;
    result.set(record.userId, { lists: [...record.lists] });
  }
  for (const record of overlay) {
    if (!record || allowedIds.has(record.userId)) continue;
    const existing = result.get(record.userId);
    if (existing) {
      // 官方条目与本地覆盖都命中同一个账号：列表取并集，卡片上只列一次。
      existing.lists = [...new Set([...existing.lists, ...record.lists])];
    } else {
      result.set(record.userId, { lists: [...record.lists] });
    }
  }
  return result;
}

/** 应用一批差量操作。 */
export async function applyChanges(
  listId: string,
  ops: readonly { op: "add" | "remove"; userId: string; screenName?: string }[],
): Promise<void> {
  if (ops.length === 0) return;
  const database = await db();
  const tx = database.transaction("filtered", "readwrite");
  const store = tx.objectStore("filtered");
  for (const op of ops) {
    const existing = await store.get(op.userId);
    if (op.op === "add") {
      if (existing) {
        const screenName = existing.screenName ?? op.screenName;
        if (!existing.lists.includes(listId) || screenName !== existing.screenName) {
          await store.put({ ...existing, screenName, lists: [...existing.lists, listId] });
        }
      } else {
        await store.put({
          userId: op.userId,
          screenName: op.screenName,
          lists: [listId],
          at: Date.now(),
        });
      }
    } else if (existing) {
      const lists = existing.lists.filter((id) => id !== listId);
      if (lists.length > 0) await store.put({ ...existing, lists });
      else await store.delete(op.userId);
    }
  }
  await tx.done;
}

/** 用全量快照替换某个列表的条目（差量已被压缩时走这条路）。 */
export async function replaceListSnapshot(
  listId: string,
  userIds: readonly string[],
): Promise<void> {
  const database = await db();
  const incoming = new Set(userIds);

  // 先按列表索引找出该列表现有条目，做差集后再写入。
  const tx = database.transaction("filtered", "readwrite");
  const store = tx.objectStore("filtered");
  const index = store.index("byList");
  for await (const cursor of index.iterate(listId)) {
    const record = cursor.value;
    if (!incoming.has(record.userId)) {
      const lists = record.lists.filter((id) => id !== listId);
      if (lists.length > 0) await store.put({ ...record, lists });
      else await store.delete(record.userId);
    }
  }
  await tx.done;

  const writeTx = database.transaction("filtered", "readwrite");
  const writeStore = writeTx.objectStore("filtered");
  const now = Date.now();
  for (const userId of incoming) {
    const existing = await writeStore.get(userId);
    if (existing) {
      if (!existing.lists.includes(listId)) {
        await writeStore.put({ ...existing, lists: [...existing.lists, listId] });
      }
    } else {
      await writeStore.put({ userId, lists: [listId], at: now });
    }
  }
  await writeTx.done;
}

/** 退订时清掉该列表带来的全部条目。 */
export async function dropList(listId: string): Promise<void> {
  await replaceListSnapshot(listId, []);
}

export async function countFiltered(): Promise<number> {
  return await (await db()).count("filtered");
}

export async function countOverlay(): Promise<number> {
  return await (await db()).count("overlay");
}

/**
 * 删掉某个列表在本地覆盖里的全部条目（删除本地列表时用）。
 *
 * 条目纪录按账号存、里面是列表集合：先摘掉这个列表，集合空了才连记录一起删。
 */
export async function removeOverlayList(listId: string): Promise<number> {
  const database = await db();
  let removed = 0;
  for (const record of await database.getAll("overlay")) {
    if (!record.lists.includes(listId)) continue;
    const rest = record.lists.filter((id) => id !== listId);
    if (rest.length === 0) await database.delete("overlay", record.userId);
    else await database.put("overlay", { ...record, lists: rest });
    removed++;
  }
  return removed;
}

/** 某个列表在本地覆盖里的全部条目（采纳时逐条提交上线）。 */
export async function overlayForList(listId: string): Promise<OverlayRecord[]> {
  const database = await db();
  const out: OverlayRecord[] = [];
  for (const record of await database.getAll("overlay")) {
    if (record.lists.includes(listId)) out.push(record);
  }
  return out;
}

/** 本地覆盖里每个列表各有多少账号（自建列表的条目数就是这么来的）。 */
export async function overlayCounts(): Promise<Map<string, number>> {
  const database = await db();
  const counts = new Map<string, number>();
  for (const record of await database.getAll("overlay")) {
    for (const listId of record.lists) counts.set(listId, (counts.get(listId) ?? 0) + 1);
  }
  return counts;
}

export async function addOverlay(record: OverlayRecord): Promise<void> {
  const database = await db();
  const existing = await database.get("overlay", record.userId);
  if (existing) {
    await database.put("overlay", {
      ...existing,
      screenName: record.screenName ?? existing.screenName,
      lists: [...new Set([...existing.lists, ...record.lists])],
      // 同一个账号可能从不同帖子被加进来，留最新的那条：举报只需要一条帖子作为证据。
      tweetId: record.tweetId ?? existing.tweetId,
      tweetUrl: record.tweetUrl ?? existing.tweetUrl,
    });
    return;
  }
  await database.put("overlay", record);
}

export async function removeOverlay(userId: string): Promise<void> {
  await (await db()).delete("overlay", userId);
}

export async function listOverlay(): Promise<OverlayRecord[]> {
  return await (await db()).getAll("overlay");
}

/**
 * 用户选择「不再隐藏」：加入允许列表，匹配时跳过。
 *
 * 记下 screenName：列表页要显示成 @handle。早期只存 userId，界面上只能摆一串数字，
 * 用户根本认不出是谁；下面 `listAllowed` 会为这类历史记录从本地库里补回名字。
 */
export async function allowUser(userId: string, screenName?: string): Promise<void> {
  const existing = await (await db()).get("allow", userId);
  await (await db()).put("allow", {
    userId,
    screenName: screenName ?? existing?.screenName,
    at: Date.now(),
  });
}

export async function disallowUser(userId: string): Promise<void> {
  await (await db()).delete("allow", userId);
}

export async function listAllowed(): Promise<AllowRecord[]> {
  const database = await db();
  const records = await database.getAll("allow");
  const out: AllowRecord[] = [];
  for (const record of records) {
    let screenName = record.screenName;
    if (!screenName) {
      // 历史记录里没有名字：这个账号当初一定命中过过滤库（filtered）或本地覆盖（overlay），
      // 从那儿把 @handle 找回来，顺便写回，避免每次都要查。
      const source = await database.get("filtered", record.userId) ??
        await database.get("overlay", record.userId);
      if (source?.screenName) {
        screenName = source.screenName;
        await database.put("allow", { ...record, screenName });
      }
    }
    out.push({ userId: record.userId, screenName, at: record.at });
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function enqueueReport(record: OutboxRecord): Promise<number> {
  return await (await db()).add("outbox", record);
}

export async function listReportQueue(): Promise<OutboxRecord[]> {
  return await (await db()).getAllFromIndex("outbox", "byCreated");
}

export async function deleteReport(id: number): Promise<void> {
  await (await db()).delete("outbox", id);
}

export async function updateReport(record: OutboxRecord): Promise<void> {
  await (await db()).put("outbox", record);
}

export interface ExportBundle {
  version: 1;
  exportedAt: number;
  config: unknown;
  accountKey: string | null;
  filtered: FilteredRecord[];
  overlay: OverlayRecord[];
  allow: { userId: string; at: number }[];
  outbox: OutboxRecord[];
}

export async function exportAll(): Promise<Omit<ExportBundle, "config" | "accountKey">> {
  const database = await db();
  return {
    version: 1,
    exportedAt: Date.now(),
    filtered: await database.getAll("filtered"),
    overlay: await database.getAll("overlay"),
    allow: await database.getAll("allow"),
    outbox: await database.getAll("outbox"),
  };
}

export async function importAll(bundle: Omit<ExportBundle, "config" | "accountKey">): Promise<void> {
  const database = await db();
  const tx = database.transaction(["filtered", "overlay", "allow", "outbox"], "readwrite");
  for (const storeName of ["filtered", "overlay", "allow", "outbox"] as const) {
    await tx.objectStore(storeName).clear();
  }
  for (const record of bundle.filtered) await tx.objectStore("filtered").put(record);
  for (const record of bundle.overlay) await tx.objectStore("overlay").put(record);
  for (const record of bundle.allow) await tx.objectStore("allow").put(record);
  for (const record of bundle.outbox) {
    const { id, ...rest } = record;
    await tx.objectStore("outbox").add({ ...rest, id });
  }
  await tx.done;
}

/** 清空所有本地数据（用于「重置扩展」）。 */
export async function clearAll(): Promise<void> {
  const database = await db();
  const tx = database.transaction(["filtered", "overlay", "allow", "outbox"], "readwrite");
  for (const storeName of ["filtered", "overlay", "allow", "outbox"] as const) {
    await tx.objectStore(storeName).clear();
  }
  await tx.done;
}
