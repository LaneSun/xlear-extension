/** 理由的最近确认记录，只存列表 ID 与时间，不记录账号或帖子。 */
export interface ReasonHistory {
  lastUsed: Record<string, number>;
  lastSelection: string[];
}

const HISTORY_CAP = 256;
const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;

/** 兼容旧存储，并为已删除列表留下的历史设定上限。 */
export function normalizeReasonHistory(value: unknown): ReasonHistory {
  const raw = value && typeof value === "object" ? value : {};
  const used = "lastUsed" in raw && raw.lastUsed &&
      typeof raw.lastUsed === "object"
    ? raw.lastUsed
    : {};
  const entries = Object.entries(used).filter(
    (entry): entry is [string, number] =>
      validId(entry[0]) && typeof entry[1] === "number" &&
      Number.isSafeInteger(entry[1]) && entry[1] >= 0 && entry[1] < 8.64e15,
  ).sort((a, b) => b[1] - a[1]).slice(0, HISTORY_CAP);
  const retained = new Set(entries.map(([id]) => id));
  const selection = "lastSelection" in raw && Array.isArray(raw.lastSelection)
    ? raw.lastSelection.filter(validId)
    : [];
  return {
    lastUsed: Object.fromEntries(entries),
    lastSelection: [...new Set(selection)].filter((id) => retained.has(id)),
  };
}

/** 只在用户确认并完成 X 的原生确认流程后调用；取消或单纯勾选不写记录。 */
export function rememberReasonSelection(
  history: ReasonHistory,
  ids: readonly string[],
  now = Date.now(),
): ReasonHistory {
  const current = normalizeReasonHistory(history);
  const selected = [...new Set(ids.filter(validId))].slice(0, HISTORY_CAP);
  if (selected.length === 0) return current;
  // 同一毫秒提交或系统时钟回拨时，仍然按确认先后排序。
  const timestamp = Math.max(
    now,
    ...Object.values(current.lastUsed).map((t) => t + 1),
  );
  return normalizeReasonHistory({
    lastUsed: {
      ...current.lastUsed,
      ...Object.fromEntries(selected.map((id) => [id, timestamp])),
    },
    lastSelection: selected,
  });
}

/** 只对调用方已经筛选过的可用理由排序，历史不能重新引入停用或退订列表。 */
export function recentReasonLists<T extends { id: string }>(
  lists: readonly T[],
  history?: ReasonHistory,
): { lists: T[]; previousIds: string[] } {
  const current = normalizeReasonHistory(history);
  const used = new Map(Object.entries(current.lastUsed));
  const available = new Set(lists.map((list) => list.id));
  return {
    // 稳定排序：同次确认的理由、从未使用的理由保留目录顺序。
    lists: [...lists].sort((a, b) =>
      (used.get(b.id) ?? -1) - (used.get(a.id) ?? -1)
    ),
    previousIds: current.lastSelection.filter((id) => available.has(id)),
  };
}
