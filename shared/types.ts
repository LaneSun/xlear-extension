import type { SubmitResult } from "./constants.ts";

/** 扩展用到的接口数据形状（与服务端契约同源，按引用裁剪）。 */

export interface AccountCreateResponse {
  accountId: string;
  /** 仅此一次返回。 */
  key: string;
}

export interface AccountMeResponse {
  accountId: string;
}

/** 差量同步里的一条操作。 */
export interface ChangeOp {
  seq: number;
  op: "add" | "remove";
  userId: string;
  screenName?: string;
  at: number;
}

export interface ChangesResponse {
  listId: string;
  ops: ChangeOp[];
  version: number;
  minRetainedSeq: number;
  hasMore: boolean;
}

/**
 * 给客户端看的列表摘要。`name` / `reason` 已按请求语言解析好，
 * 只包含渲染列表选择器需要的字段。
 */
export interface ListSummary {
  id: string;
  name: string;
  reason: string;
  entryCount: number;
  subscriberCount: number;
  /** 差量信号：与本地记录的版本不同才需要拉 /changes。 */
  version: number;
  /** 仅供展示的新鲜度，不参与是否请求的判断。 */
  updatedAt: number;
}

export interface ListsResponse {
  lists: ListSummary[];
  generatedAt: number;
}

export interface ReportSubmission {
  target: { userId: string; screenName?: string };
  listIds: string[];
  tweet: { id: string; url?: string; text?: string; capturedAt?: string };
}

export interface ReportSubmitResult {
  listId: string;
  status: SubmitResult;
  reportId?: string;
  detail?: string;
}

export interface ReportsResponse {
  results: ReportSubmitResult[];
}

export interface SnapshotLine {
  listId: string;
  userId: string;
  screenName?: string;
  at: number;
}
