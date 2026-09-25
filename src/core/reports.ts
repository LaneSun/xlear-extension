/**
 * 举报提交与失败重试。
 *
 * 每次提交都先写本地 outbox，再尝试发出；失败就留在队列里，由定时任务重试。
 * 这样即使服务端临时不可用，用户的屏蔽动作也不会白做。
 */
import type { ReportSubmitResult } from "../../shared/types.ts";
import { submitReports } from "./api.ts";
import { ensureAccount } from "./account.ts";
import { deleteReport, enqueueReport, listReportQueue, updateReport } from "./storage.ts";

export interface ReportTarget {
  userId: string;
  screenName?: string;
}

export interface ReportTweet {
  id: string;
  url?: string;
  text?: string;
}

const MAX_ATTEMPTS = 5;

/** 把一次屏蔽动作提交到平台（可多列表）。返回逐列表的结果。 */
export async function submitBlockReport(
  target: ReportTarget,
  listIds: readonly string[],
  tweet: ReportTweet,
): Promise<ReportSubmitResult[]> {
  if (listIds.length === 0) return [];
  for (const listId of listIds) {
    await enqueueReport({
      listId,
      userId: target.userId,
      screenName: target.screenName,
      tweetId: tweet.id,
      tweetUrl: tweet.url,
      tweetText: tweet.text,
      createdAt: Date.now(),
      attempts: 0,
    });
  }
  return await flushOutbox();
}

/** 冲掉队列里待发的举报。返回逐列表结果。 */
export async function flushOutbox(): Promise<ReportSubmitResult[]> {
  const queue = await listReportQueue();
  if (queue.length === 0) return [];
  const key = await ensureAccount();
  const results: ReportSubmitResult[] = [];

  // 按「目标 + 帖子」聚合，一次请求带上多个列表，减少往返。
  const groups = new Map<string, typeof queue>();
  for (const record of queue) {
    const groupKey = `${record.userId}|${record.tweetId}`;
    const bucket = groups.get(groupKey);
    if (bucket) bucket.push(record);
    else groups.set(groupKey, [record]);
  }

  for (const records of groups.values()) {
    const first = records[0];
    if (!first) continue;
    try {
      const response = await submitReports(key, {
        target: { userId: first.userId, screenName: first.screenName },
        listIds: records.map((record) => record.listId),
        tweet: {
          id: first.tweetId,
          url: first.tweetUrl,
          text: first.tweetText,
          capturedAt: new Date(first.createdAt).toISOString(),
        },
      });
      results.push(...response.results);
      for (const record of records) {
        if (record.id !== undefined) await deleteReport(record.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const record of records) {
        const attempts = record.attempts + 1;
        if (record.id === undefined) continue;
        if (attempts >= MAX_ATTEMPTS) {
          await deleteReport(record.id);
        } else {
          await updateReport({ ...record, attempts, lastError: message });
        }
      }
      // 整批没送达（网络故障等）：逐列表记一笔，结果与提交的列表一一对应。
      // 用 `queued` 而不是 `rejected`：这批举报还在队列里等着重试，界面要如实说明。
      for (const record of records) {
        results.push({ listId: record.listId, status: "queued", detail: message });
      }
    }
  }
  return results;
}

/** 供 popup 显示的队列长度。 */
export async function outboxSize(): Promise<number> {
  return (await listReportQueue()).length;
}

