/**
 * 屏蔽理由弹窗列哪些名单。
 *
 * 规则就一句话：**用户勾过的才算数** —— 服务器列表看订阅集合，本地列表看生效开关。
 * 没订阅的服务器列表不进来（举报是"我为什么屏蔽它"，不该让用户替别人做选择），
 * 停用的本地列表也不进来（条目还在，只是现在不算数）。
 *
 * 单独成一个模块、不带任何依赖：这段筛选是屏蔽流程的分叉点，
 * 它错了用户就点不到自己想用的名单，因此要能脱离浏览器直接跑逻辑验证。
 */

export interface DialogList {
  id: string;
  name: string;
  reason: string;
}

export function dialogLists(input: {
  /** 服务器目录（名字与理由已按当前语言取好）。 */
  server: readonly DialogList[];
  /** 自建列表，带生效开关。 */
  local: readonly (DialogList & { enabled: boolean })[];
  /** 已订阅的服务器列表 id。 */
  subscribed: readonly string[];
}): DialogList[] {
  const subscribed = new Set(input.subscribed);
  const pick = ({ id, name, reason }: DialogList): DialogList => ({
    id,
    name,
    reason,
  });
  return [
    // 本地列表排在前面：它们是用户自己写的那几条，顺序也与设置页一致。
    ...input.local.filter((list) => list.enabled).map(pick),
    ...input.server.filter((list) => subscribed.has(list.id)).map(pick),
  ];
}
