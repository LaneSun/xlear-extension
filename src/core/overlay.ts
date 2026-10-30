/**
 * 本地覆盖（overlay）被在线条目接管的规则。
 *
 * 覆盖是"平台还没复核完"时的临时生效：用户提交举报后，账号马上在本机被隐藏。
 * 一旦这个账号真的出现在在线列表里（同步拉下来的 `filtered` 条目），那份覆盖就多余了 ——
 * 不摘掉的话，界面会一直把它显示成"待复核的本地覆盖"，同一份屏蔽也被记在两处。
 *
 * 只摘**该账号确实已经在那个列表里**的那几项。属于本地列表的条目永远留着：
 * 它们只在本机生效（不出设备），在线列表无从接管。
 */

/** 覆盖记录里用到的字段；只取所需，因此不依赖 storage 的类型（那个模块要 IndexedDB）。 */
export interface OverlayLike {
  userId: string;
  lists: string[];
  evidence?: Record<string, OverlayEvidence>;
  /** 旧版本只按账号存证据；多列表记录无法确定归属，不自动上传。 */
  tweetId?: string;
  tweetUrl?: string;
}

export interface OverlayEvidence {
  tweetId: string;
  tweetUrl?: string;
}

export function overlayEvidence(record: OverlayLike, listId: string): OverlayEvidence | undefined {
  if (!record.lists.includes(listId)) return undefined;
  if (record.evidence) return record.evidence[listId];
  return record.lists.length === 1 && record.tweetId
    ? { tweetId: record.tweetId, tweetUrl: record.tweetUrl }
    : undefined;
}

/** 删除成员关系时同时整理证据，不能让旧的多列表证据变成单列表证据。 */
export function withOverlayLists<T extends OverlayLike>(record: T, lists: string[]): T {
  const evidence = Object.fromEntries(lists.flatMap((id) => {
    const value = overlayEvidence(record, id);
    return value ? [[id, value]] : [];
  }));
  return { ...record, lists, evidence };
}

export function mergeOverlay<T extends OverlayLike>(existing: T | undefined, incoming: T): T {
  const before = existing ? withOverlayLists(existing, existing.lists) : undefined;
  const next = withOverlayLists(incoming, incoming.lists);
  return {
    ...before,
    ...next,
    lists: [...new Set([...(before?.lists ?? []), ...next.lists])],
    evidence: { ...before?.evidence, ...next.evidence },
  };
}

/**
 * 算出接管之后该留下的覆盖记录。
 *
 * `onlineListsByUser`：账号 → 它已经在线的列表 id（来自同步下来的条目）。
 * 返回的记录是浅拷贝（`lists` 换成新数组），其余字段原样保留。
 */
export function takeOverCoveredOverlay<T extends OverlayLike>(
  records: readonly T[],
  onlineListsByUser: ReadonlyMap<string, readonly string[]>,
): T[] {
  const kept: T[] = [];
  for (const record of records) {
    const online = new Set(onlineListsByUser.get(record.userId) ?? []);
    const lists = record.lists.filter((id) => !online.has(id));
    if (lists.length > 0) {
      kept.push(
        lists.length === record.lists.length
          ? { ...record, lists }
          : withOverlayLists(record, lists),
      );
    }
  }
  return kept;
}
