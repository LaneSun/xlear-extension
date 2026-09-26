/**
 * 同步：把订阅列表拉到本地。
 *
 * 每个列表记一个已应用的版本号，之后只拉差量。如果服务端告知本地落后于保留水位
 * （差量被压缩了），就整表重拉。同步结束会打一次订阅卡，用于服务端统计活跃度。
 */
import { loadConfig, loadState, mutateState, patchConfig, type ExtensionConfig } from "./config.ts";
import type { ListSummary } from "../../shared/types.ts";
import { fetchChanges, fetchLists, fetchSnapshot } from "./api.ts";
import { applyChanges, countFiltered, replaceListSnapshot } from "./storage.ts";

export interface SyncResult {
  /** 处理过的列表数。 */
  lists: number;
  /** 同步后本地的条目总数。 */
  totalEntries: number;
  errors: string[];
}

export async function syncAll(
  config?: ExtensionConfig,
  options: { force?: boolean; catalog?: ListSummary[] } = {},
): Promise<SyncResult> {
  const current = config ?? await loadConfig();
  const state = await loadState();
  const result: SyncResult = { lists: 0, totalEntries: 0, errors: [] };

  // 目录先行：它是"哪些列表存在、各自到哪一版"的唯一来源。
  // 本地列表不在目录里，也就永远不会走到网络请求上。
  const catalog: ListSummary[] = options.catalog ?? (await fetchLists()).lists;
  const known = new Set(catalog.map((list) => list.id));
  const stale = current.subscriptions.filter((id) => !known.has(id));
  if (stale.length > 0) {
    // 订阅了目录里没有的列表（被下架或删掉）：静默丢弃，不当作错误 —— 用户没做错任何事。
    await patchConfig({ subscriptions: current.subscriptions.filter((id) => known.has(id)) });
    console.info(`[xlear] 已丢弃目录里不存在的订阅：${stale.join("、")}`);
  }
  const targets = current.subscriptions.filter((id) => known.has(id));
  const byId = new Map(catalog.map((list) => [list.id, list]));

  for (const listId of targets) {
    const record = state.listVersions[listId];
    const since = options.force ? 0 : record?.version ?? 0;
    // 版本没动就不请求：包管理器式的纪律，一次目录 + 几个真正变了的列表。
    if (!options.force && record && record.version >= (byId.get(listId)?.version ?? 0)) {
      result.lists++;
      continue;
    }
    try {
      const changes = await fetchChanges(listId, since);
      // 整表重拉的两种情形：差量已被压缩（本地版本落后于保留水位），或用户手动强制同步。
      // 强制同步走全量，才能把服务端已删除的条目一并清掉。
      if (options.force || changes.minRetainedSeq > since) {
        let count = 0;
        const userIds: string[] = [];
        await fetchSnapshot(listId, (line) => {
          userIds.push(line.userId);
          count++;
        });
        await replaceListSnapshot(listId, userIds);
        state.listVersions[listId] = {
          version: changes.version,
          lastSyncAt: Date.now(),
          entries: count,
        };
      } else {
        // 差量可能被服务端分页截断（hasMore）：必须把本轮的差量全部应用完，
        // 才能把水位推进到 `version`——否则客户端会"自认为已同步到最新"而静默漏掉后面的操作。
        let cursor = since;
        let added = 0;
        let removed = 0;
        let page = changes;
        for (;;) {
          if (page.ops.length > 0) {
            await applyChanges(listId, page.ops);
            added += page.ops.filter((op) => op.op === "add").length;
            removed += page.ops.filter((op) => op.op === "remove").length;
            cursor = page.ops[page.ops.length - 1]!.seq;
          }
          if (!page.hasMore) {
            state.listVersions[listId] = {
              version: page.version,
              lastSyncAt: Date.now(),
              entries: Math.max(0, (record?.entries ?? 0) + added - removed),
            };
            break;
          }
          if (page.ops.length === 0) {
            // 服务端说"还有更多"却没给任何操作：既不推进水位（下次同步重试），
            // 也不在这里死循环。这种响应本身是异常的，记下来。
            result.errors.push(`${listId}: 服务端返回 hasMore 但没有差量`);
            break;
          }
          page = await fetchChanges(listId, cursor);
        }
      }
      result.lists++;
    } catch (error) {
      result.errors.push(`${listId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await mutateState(() => ({
    listVersions: state.listVersions,
    lastSyncAt: Date.now(),
    lastSyncError: result.errors.length > 0 ? result.errors.join("; ") : undefined,
  }));
  result.totalEntries = await countFiltered();
  return result;
}
