/**
 * 举报提交与失败重试。
 *
 * 每次提交都先写本地 outbox，再尝试发出；失败就留在队列里，由定时任务重试。
 * 这样即使服务端临时不可用，用户的屏蔽动作也不会白做。
 */
import type { ReportSubmitResult } from "../../contract/types.ts";
import { submitReports } from "./api.ts";
import { ensureAccount } from "./account.ts";
import { loadConfig } from "./config.ts";
import { submissionsAllowed } from "./submission.ts";
import {
  deleteReport,
  enqueueReport,
  listReportQueue,
  type OutboxRecord,
  updateReport,
} from "./storage.ts";

export interface ReportTarget {
  userId: string;
  screenName?: string;
}

export interface ReportTweet {
  id: string;
  url?: string;
  text?: string;
}

/**
 * 一次举报的去向。
 *
 * `submitted` 说的是**面向服务端的那部分有没有真的发出去**：关闭「在线提交」后它是 false，
 * 界面据此如实说明"只在本机生效"，而不是让用户以为举报已经交上去了。
 */
export interface ReportOutcome {
  results: ReportSubmitResult[];
  submitted: boolean;
}

const MAX_ATTEMPTS = 5;

/** 把一次屏蔽动作提交到平台（可多列表）。返回逐列表的结果。 */
export async function submitBlockReport(
  target: ReportTarget,
  listIds: readonly string[],
  tweet: ReportTweet,
): Promise<ReportOutcome> {
  return await queueOutbox(() => enqueueAndSubmit(target, listIds, tweet));
}

async function enqueueAndSubmit(
  target: ReportTarget,
  listIds: readonly string[],
  tweet: ReportTweet,
): Promise<ReportOutcome> {
  if (listIds.length === 0) return { results: [], submitted: true };
  // 「在线提交」关闭时既不提交、也不进队列：队列是"待发"的意思，进了就会在重新打开后
  // 自动补发，那不是用户关掉它时的预期。已经躺在队列里的（开关还开着时留下的）不动。
  if (!submissionsAllowed(await loadConfig())) {
    return { results: [], submitted: false };
  }
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
  return {
    results: (await flushOnce({ userId: target.userId, tweetId: tweet.id }))
      .filter((result) => listIds.includes(result.listId)),
    submitted: true,
  };
}

/** 冲掉队列里待发的举报。返回逐列表结果；关闭「在线提交」时队列原样留着。 */
let outboxQueue: Promise<unknown> = Promise.resolve();
function queueOutbox<T>(operation: () => Promise<T>): Promise<T> {
  const result = outboxQueue.then(operation);
  outboxQueue = result.catch(() => {});
  return result;
}

export function flushOutbox(): Promise<ReportSubmitResult[]> {
  return queueOutbox(() => flushOnce());
}

/** 采纳列表时先把全部证据可靠入队，网络失败不能中断后续条目或阻塞名单转换。 */
export function enqueueAdoptedReports(records: readonly OutboxRecord[]): Promise<number> {
  return queueOutbox(async () => {
    if (!submissionsAllowed(await loadConfig())) return 0;
    const identity = (record: OutboxRecord) =>
      JSON.stringify([record.userId, record.tweetId, record.listId]);
    const known = new Set((await listReportQueue()).map(identity));
    let added = 0;
    for (const record of records) {
      if (known.has(identity(record))) continue;
      await enqueueReport(record);
      known.add(identity(record));
      added++;
    }
    return added;
  });
}

async function flushOnce(
  target?: { userId: string; tweetId: string },
): Promise<ReportSubmitResult[]> {
  const queue = await listReportQueue();
  if (queue.length === 0) return [];
  if (!submissionsAllowed(await loadConfig())) return [];
  let key: string;
  try {
    key = await ensureAccount();
  } catch (error) {
    // 首次申请账号也可能离线；举报已入队，回执仍应说明待重试，不能抹掉本地成功。
    const detail = error instanceof Error ? error.message : String(error);
    return queue.filter((record) =>
      !target || (record.userId === target.userId && record.tweetId === target.tweetId)
    ).map((record) => ({ listId: record.listId, status: "queued", detail }));
  }
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
    const relevant = !target ||
      (target.userId === first.userId && target.tweetId === first.tweetId);
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
      if (relevant) results.push(...response.results);
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
      // 仍能重试时标为 queued，达到上限出队时标为 rejected，不能声称仍在等重试。
      for (const record of records) {
        if (relevant) {
          results.push({
            listId: record.listId,
            status: record.attempts + 1 >= MAX_ATTEMPTS ? "rejected" : "queued",
            detail: message,
          });
        }
      }
    }
  }
  return results;
}

/** 供 popup 显示的队列长度。 */
export async function outboxSize(): Promise<number> {
  return (await listReportQueue()).length;
}
