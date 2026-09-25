/** 与服务端通讯的客户端。扩展侧唯一发起网络请求的地方。 */
import type {
  AccountCreateResponse,
  AccountMeResponse,
  ChangesResponse,
  ListsResponse,
  ReportSubmission,
  ReportsResponse,
  SnapshotLine,
} from "../../shared/types.ts";
import { API } from "../../shared/constants.ts";
import { SERVER_URL } from "./server.ts";
import { t } from "../i18n.ts";
import { localeSignal } from "./locale.ts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 服务端地址是常量（见 server.ts），这里只去掉末尾斜杠便于拼路径。 */
const BASE = SERVER_URL.replace(/\/+$/, "");

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      // 扩展是独立客户端：带上网站 cookie 会让网站的语言设置盖掉扩展的语言设置
      // （服务端的优先级是 ?lang → cookie → Accept-Language），列表名与理由就会串语言。
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        // 服务端按这个头返回本地化的列表名与理由。
        "accept-language": `${localeSignal.value}, en;q=0.8`,
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    throw new ApiError(
      t("ext.api.connectFailed", {
        base: BASE,
        message: error instanceof Error ? error.message : String(error),
      }),
      0,
    );
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(payload.error ?? `HTTP ${response.status}`, response.status);
  }
  return await response.json() as T;
}

export function fetchLists(): Promise<ListsResponse> {
  return request<ListsResponse>(API.lists);
}

export function fetchChanges(
  listId: string,
  since: number,
): Promise<ChangesResponse> {
  const query = new URLSearchParams({ since: String(since) });
  return request<ChangesResponse>(`${API.listChanges(listId)}?${query}`);
}

/** 全量快照按 NDJSON 流式返回，这里逐行解析。 */
export async function fetchSnapshot(
  listId: string,
  onRecord: (line: SnapshotLine) => void,
): Promise<number> {
  let cursor: string | null = null;
  let total = 0;
  do {
    const query = new URLSearchParams({ cursor: cursor ?? "" });
    const response = await fetch(`${BASE}${API.listSnapshot(listId)}?${query}`, {
      // 同上：不带网站 cookie，语言只按扩展自己的设置。
      credentials: "omit",
      headers: {
        accept: "application/x-ndjson",
        "accept-language": `${localeSignal.value}, en;q=0.8`,
      },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new ApiError(t("ext.api.snapshotFailed", { status: response.status }), response.status);
    }
    const text = await response.text();
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      const parsed = JSON.parse(line) as SnapshotLine & { done?: boolean; nextCursor?: string | null };
      if (parsed.done) {
        cursor = parsed.nextCursor ?? null;
        break;
      }
      onRecord(parsed);
      total++;
    }
  } while (cursor);
  return total;
}

/** 按需申请账号。仅在用户第一次提交举报时调用。 */
export function createAccount(): Promise<AccountCreateResponse> {
  return request<AccountCreateResponse>(API.account, { method: "POST" });
}

export function fetchMe(key: string): Promise<AccountMeResponse> {
  return request<AccountMeResponse>(API.accountMe, {
    headers: { authorization: `Bearer ${key}` },
  });
}

export function submitReports(
  key: string,
  submission: ReportSubmission,
): Promise<ReportsResponse> {
  return request<ReportsResponse>(API.reports, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(submission),
  });
}
