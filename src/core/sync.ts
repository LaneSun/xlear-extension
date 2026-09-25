/**
 * 同步：把订阅列表拉到本地。
 *
 * 每个列表记一个已应用的版本号，之后只拉差量。如果服务端告知本地落后于保留水位
 * （差量被压缩了），就整表重拉。同步结束会打一次订阅卡，用于服务端统计活跃度。
 */
import { loadConfig, loadState, mutateState, type ExtensionConfig } from "./config.ts";
import { fetchChanges, fetchSnapshot } from "./api.ts";
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
  options: { force?: boolean; listIds?: string[] } = {},
): Promise<SyncResult> {
  const current = config ?? await loadConfig();
  const state = await loadState();
  const targets = options.listIds ?? current.subscriptions;
  const result: SyncResult = { lists: 0, totalEntries: 0, errors: [] };

  for (const listId of targets) {
    const record = state.listVersions[listId];
    const since = options.force ? 0 : record?.version ?? 0;
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
