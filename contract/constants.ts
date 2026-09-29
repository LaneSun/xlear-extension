/** 提交结果：accepted / duplicate / rejected / queued（queued 表示这次没送达，客户端留着重试）。 */
const SUBMIT_RESULTS = ["accepted", "duplicate", "rejected", "queued"] as const;
export type SubmitResult = typeof SUBMIT_RESULTS[number];

/** 扩展要用的接口路径。 */
export const API = {
  lists: "/api/lists",
  listChanges: (id: string) => `/api/lists/${encodeURIComponent(id)}/changes`,
  listSnapshot: (id: string) => `/api/lists/${encodeURIComponent(id)}/snapshot`,
  account: "/api/account",
  accountMe: "/api/account/me",
  /** 自建列表的名称与理由，纯收集。 */
  candidates: "/api/candidates",
  reports: "/api/reports",
} as const;
