/**
 * 内容脚本 / 界面与后台之间的消息协议。
 *
 * 请求都由内容脚本或界面发起，后台只做决策与持久化：
 * 匹配、订阅列表、执行许可、提交举报、同步、配置与迁移。
 */
import { browser } from "wxt/browser";
import type { ListSummary, ReportSubmitResult } from "../../shared/types.ts";
import type { ExtensionConfig } from "./config.ts";
import type { AllowRecord, OutboxRecord, OverlayRecord } from "./storage.ts";

/* ------------------------------- 内容脚本 ------------------------------- */

export interface MatchRequest {
  type: "match";
  userIds: string[];
}

export interface MatchResponse {
  matches: { userId: string; lists: string[] }[];
}

export interface ListsRequest {
  type: "lists";
  force?: boolean;
}

export interface ListsResponse {
  lists: ListSummary[];
  subscriptions: string[];
  locale: ExtensionConfig["locale"];
}


export interface SubmitRequest {
  type: "submitReport";
  userId: string;
  screenName?: string;
  tweetId: string;
  tweetUrl?: string;
  tweetText?: string;
  listIds: string[];
}

export interface SubmitResponse {
  results: ReportSubmitResult[];
  error?: string;
}

export interface AddOverlayRequest {
  type: "addOverlay";
  userId: string;
  screenName?: string;
  listIds: string[];
}

export interface CreateLocalListRequest {
  type: "createLocalList";
  name: string;
  reason: string;
}

export interface LocalListResponse {
  id: string;
}

export interface RenameLocalListRequest {
  type: "renameLocalList";
  id: string;
  name: string;
  reason: string;
}

export interface DeleteLocalListRequest {
  type: "deleteLocalList";
  id: string;
}

export interface AllowRequest {
  type: "allow";
  userId: string;
  /** 从卡片上带过来，列表页就能显示 @handle 而不是一串数字。 */
  screenName?: string;
}

export interface CountRequest {
  type: "countHidden";
  /** 本批被隐藏的账号（内容脚本已按账号去重）。 */
  userIds: string[];
}

/* --------------------------------- 界面 --------------------------------- */

export interface StatusRequest {
  type: "status";
}

export interface StatusResponse {
  enabled: boolean;
  lastSyncAt: number;
  lastSyncError?: string;
  entries: number;
  overlay: number;
  counters: { day: string; hiddenAccounts: string[] };
  outbox: number;
  hasAccount: boolean;
}

export interface SyncNowRequest {
  type: "syncNow";
  force?: boolean;
}

export interface SyncNowResponse {
  lists: number;
  entries: number;
  errors: string[];
}

export interface UpdateConfigRequest {
  type: "updateConfig";
  patch: Partial<ExtensionConfig>;
}

export interface ConfigResponse {
  config: ExtensionConfig;
}

export interface GetConfigRequest {
  type: "getConfig";
}

export interface DiagnoseCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface DiagnoseRequest {
  type: "diagnose";
}

export interface DiagnoseResponse {
  url: string;
  checks: DiagnoseCheck[];
}

export interface FlushOutboxRequest {
  type: "flushOutbox";
}


export interface OverlayListRequest {
  type: "overlayList";
}

export interface OverlayListResponse {
  overlay: OverlayRecord[];
}

export interface DropOverlayRequest {
  type: "dropOverlay";
  userId: string;
}

export interface AllowListRequest {
  type: "allowList";
}

export interface AllowListResponse {
  allowed: AllowRecord[];
}

export interface UnallowRequest {
  type: "unallow";
  userId: string;
}

export interface OutboxListRequest {
  type: "outboxList";
}

export interface OutboxListResponse {
  outbox: OutboxRecord[];
}

export interface WebdavSyncRequest {
  type: "webdavSync";
  direction: "push" | "pull";
}

export interface WebdavTestRequest {
  type: "webdavTest";
}

export interface WebdavResultResponse {
  ok: boolean;
  message: string;
}

export interface ClearAllRequest {
  type: "clearAll";
}

export type ExtensionMessage =
  | CreateLocalListRequest
  | RenameLocalListRequest
  | DeleteLocalListRequest
  | MatchRequest
  | ListsRequest
  | SubmitRequest
  | AddOverlayRequest
  | AllowRequest
  | CountRequest
  | StatusRequest
  | SyncNowRequest
  | UpdateConfigRequest
  | GetConfigRequest
  | DiagnoseRequest
  | FlushOutboxRequest
  | OverlayListRequest
  | DropOverlayRequest
  | AllowListRequest
  | UnallowRequest
  | OutboxListRequest
  | WebdavSyncRequest
  | WebdavTestRequest
  | ClearAllRequest;

export type MessageResponse =
  | MatchResponse
  | ListsResponse
  | LocalListResponse
  | { ok: boolean }
  | SubmitResponse
  | StatusResponse
  | SyncNowResponse
  | ConfigResponse
  | DiagnoseResponse
  | OverlayListResponse
  | AllowListResponse
  | OutboxListResponse
  | WebdavResultResponse
  | { ok: true }
  | { error: string };

/** 类型安全的请求封装。 */
export function sendMessage<T extends MessageResponse>(message: ExtensionMessage): Promise<T> {
  return browser.runtime.sendMessage(message) as Promise<T>;
}
