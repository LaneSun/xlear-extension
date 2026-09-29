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
    if (lists.length > 0) kept.push({ ...record, lists });
  }
  return kept;
}
