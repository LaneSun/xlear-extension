/**
 * 本地存储。
 *
 * 过滤条目可能有几十万条，`storage.local` 的容量撑不住，因此集合类数据放 IndexedDB：
 * - `filtered`：在线列表的缓存，按账号 ID 建主键，另按列表建多值索引；退订只停用、不清空；
 * - `overlay`：用户提交后立刻生效的本地覆盖（平台尚未审核）；
 * - `allow`：用户手动「仍然显示」的账号，优先级最高；
 * - `outbox`：提交失败待重试的举报。
 */
import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import {
  mergeOverlay,
  type OverlayEvidence,
  takeOverCoveredOverlay,
  withOverlayLists,
} from "./overlay.ts";

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
  /** 证据属于列表成员关系，同一账号的不同理由不能共用最后一条帖子。 */
  evidence?: Record<string, OverlayEvidence>;
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
        const filtered = database.createObjectStore("filtered", {
          keyPath: "userId",
        });
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
  /** 当前订阅的在线列表与启用的本地列表；旧缓存、退订与停用列表都不参与判定。 */
  activeLists: ReadonlySet<string>,
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
    const lists = record.lists.filter((id) => activeLists.has(id));
    if (lists.length > 0) result.set(record.userId, { lists });
  }
  for (const record of overlay) {
    if (!record || allowedIds.has(record.userId)) continue;
    const lists = record.lists.filter((id) => activeLists.has(id));
    if (lists.length === 0) continue;
    const existing = result.get(record.userId);
    if (existing) {
      // 官方条目与本地覆盖都命中同一个账号：列表取并集，卡片上只列一次。
      existing.lists = [...new Set([...existing.lists, ...lists])];
    } else {
      result.set(record.userId, { lists: [...lists] });
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
        if (
          !existing.lists.includes(listId) || screenName !== existing.screenName
        ) {
          await store.put({
            ...existing,
            screenName,
            lists: [...new Set([...existing.lists, listId])],
          });
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
  const writeStore = store;
  const now = Date.now();
  for (const userId of incoming) {
    const existing = await writeStore.get(userId);
    if (existing) {
      if (!existing.lists.includes(listId)) {
        await writeStore.put({
          ...existing,
          lists: [...new Set([...existing.lists, listId])],
        });
      }
    } else {
      await writeStore.put({ userId, lists: [listId], at: now });
    }
  }
  await tx.done;
}

export async function countListEntries(listId: string): Promise<number> {
  return await (await db()).countFromIndex("filtered", "byList", listId);
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
  const tx = database.transaction("overlay", "readwrite");
  const store = tx.objectStore("overlay");
  let removed = 0;
  for (const record of await store.getAll()) {
    if (!record.lists.includes(listId)) continue;
    const rest = record.lists.filter((id) => id !== listId);
    if (rest.length === 0) await store.delete(record.userId);
    else await store.put(withOverlayLists(record, rest));
    removed++;
  }
  await tx.done;
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
    for (const listId of record.lists) {
      counts.set(listId, (counts.get(listId) ?? 0) + 1);
    }
  }
  return counts;
}

export async function addOverlay(record: OverlayRecord): Promise<void> {
  const database = await db();
  const tx = database.transaction("overlay", "readwrite");
  const store = tx.objectStore("overlay");
  const existing = await store.get(record.userId);
  await store.put(mergeOverlay(existing, {
    ...record,
    screenName: record.screenName ?? existing?.screenName,
    addedAt: existing?.addedAt ?? record.addedAt,
  }));
  await tx.done;
}

export async function removeOverlay(userId: string): Promise<void> {
  await (await db()).delete("overlay", userId);
}

/**
 * 从某个账号的本地覆盖里摘掉一个列表（在列表的条目视图里移除时用）。
 *
 * 与 `removeOverlayList` 是一对：那个按列表删全部账号，这个按账号删一个列表。
 */
export async function removeOverlayFromList(
  userId: string,
  listId: string,
): Promise<void> {
  const database = await db();
  const tx = database.transaction("overlay", "readwrite");
  const store = tx.objectStore("overlay");
  const record = await store.get(userId);
  if (record) {
    const lists = record.lists.filter((id) => id !== listId);
    if (lists.length === 0) await store.delete(userId);
    else await store.put(withOverlayLists(record, lists));
  }
  await tx.done;
}

export async function listOverlay(): Promise<OverlayRecord[]> {
  return await (await db()).getAll("overlay");
}

/**
 * 同步之后：在线条目已经接管走的那些覆盖条目退场。
 *
 * 判定本身是纯函数（`overlay.ts` 的 `takeOverCoveredOverlay`），这里只做 IndexedDB 的读写。
 * 返回整条记录被删掉的个数（只缩短 `lists` 的不算）。
 */
export async function pruneOverlayCoveredByOnline(): Promise<number> {
  const database = await db();
  const tx = database.transaction(["overlay", "filtered"], "readwrite");
  const overlay = tx.objectStore("overlay");
  const records = await overlay.getAll();
  const filtered = await Promise.all(
    records.map((record) => tx.objectStore("filtered").get(record.userId)),
  );
  const online = new Map<string, string[]>();
  for (const entry of filtered) {
    if (entry) online.set(entry.userId, [...entry.lists]);
  }
  const kept = new Map(
    takeOverCoveredOverlay(records, online).map((record) => [
      record.userId,
      record,
    ]),
  );
  let removed = 0;
  for (const record of records) {
    const next = kept.get(record.userId);
    if (!next) {
      await overlay.delete(record.userId);
      removed++;
    } else if (next.lists.length !== record.lists.length) {
      await overlay.put(next);
    }
  }
  await tx.done;
  return removed;
}

/**
 * 用户选择「不再隐藏」：加入允许列表，匹配时跳过。
 *
 * 记下 screenName：列表页要显示成 @handle。早期只存 userId，界面上只能摆一串数字，
 * 用户根本认不出是谁；下面 `listAllowed` 会为这类历史记录从本地库里补回名字。
 */
export async function allowUser(
  userId: string,
  screenName?: string,
): Promise<void> {
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
  allow: AllowRecord[];
  outbox: OutboxRecord[];
}

export async function exportAll(): Promise<
  Omit<ExportBundle, "config" | "accountKey">
> {
  const database = await db();
  const tx = database.transaction(["filtered", "overlay", "allow", "outbox"]);
  const result = {
    version: 1 as const,
    exportedAt: Date.now(),
    filtered: await tx.objectStore("filtered").getAll(),
    overlay: await tx.objectStore("overlay").getAll(),
    allow: await tx.objectStore("allow").getAll(),
    outbox: await tx.objectStore("outbox").getAll(),
  };
  await tx.done;
  return result;
}

export async function importAll(
  bundle: Omit<ExportBundle, "config" | "accountKey">,
): Promise<void> {
  const database = await db();
  const tx = database.transaction(
    ["filtered", "overlay", "allow", "outbox"],
    "readwrite",
  );
  try {
    for (const record of bundle.filtered) {
      const store = tx.objectStore("filtered");
      const existing = await store.get(record.userId);
      await store.put({
        ...record,
        ...existing,
        lists: [...new Set([...record.lists, ...(existing?.lists ?? [])])],
      });
    }
    for (const record of bundle.overlay) {
      const store = tx.objectStore("overlay");
      const existing = await store.get(record.userId);
      // 同一成员关系的冲突保留本机选择；新列表的成员关系取并集。
      await store.put(existing ? mergeOverlay(record, existing) : mergeOverlay(undefined, record));
    }
    for (const record of bundle.allow) {
      const store = tx.objectStore("allow");
      if (!await store.get(record.userId)) await store.put(record);
    }
    const outbox = tx.objectStore("outbox");
    const identity = (record: OutboxRecord) =>
      JSON.stringify([record.userId, record.tweetId, record.listId]);
    const known = new Set((await outbox.getAll()).map(identity));
    for (const record of bundle.outbox) {
      if (known.has(identity(record))) continue;
      const { id: _id, ...rest } = record;
      await outbox.add(rest);
      known.add(identity(record));
    }
    await tx.done;
  } catch (error) {
    // JS 校验/迭代异常不会自动 abort；数据库错误也必须消费 done 的拒绝。
    try {
      tx.abort();
    } catch { /* 已经中止或结束。 */ }
    await tx.done.catch(() => {});
    throw error;
  }
}

/** 清空所有本地数据（用于「重置扩展」）。 */
export async function clearAll(): Promise<void> {
  const database = await db();
  const tx = database.transaction(
    ["filtered", "overlay", "allow", "outbox"],
    "readwrite",
  );
  for (const storeName of ["filtered", "overlay", "allow", "outbox"] as const) {
    await tx.objectStore(storeName).clear();
  }
  await tx.done;
}
