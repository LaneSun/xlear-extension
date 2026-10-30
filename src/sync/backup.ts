/** 备份是不可信输入；完整解析成功后才允许改动任何存储。兼容旧版缺少的配置字段。 */
import { t } from "../i18n.ts";
import type { ExtensionConfig, LocalList } from "../core/settings.ts";
import type {
  AllowRecord,
  ExportBundle,
  FilteredRecord,
  OutboxRecord,
  OverlayRecord,
} from "../core/storage.ts";
import type { OverlayEvidence } from "../core/overlay.ts";

export interface BackupEnvelope {
  version: 1;
  encrypted: boolean;
  exportedAt: number;
  salt?: string;
  iv?: string;
  data: string;
}

export interface BackupPayload {
  version: 1;
  exportedAt: number;
  config:
    & Pick<ExtensionConfig, "subscriptions" | "enabled">
    & Partial<Pick<ExtensionConfig, "localLists" | "onlineSubmission" | "locale">>;
  accountKey: string | null;
  data: Omit<ExportBundle, "config" | "accountKey">;
}

function invalid(): never {
  throw new Error(t("options.transfer.invalid"));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : invalid();
}
function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : string(value);
}
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : invalid();
}
function boolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalid();
}
function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) return invalid();
  return value.map(parse);
}
function strings(value: unknown): string[] {
  return [...new Set(array(value, string))];
}
function url(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = string(value);
  if (!["https:", "http:"].includes(new URL(text).protocol)) return invalid();
  return text;
}
function evidence(value: unknown): OverlayEvidence {
  const row = object(value);
  return { tweetId: string(row.tweetId), tweetUrl: url(row.tweetUrl) };
}
function localList(value: unknown): LocalList {
  const row = object(value);
  return {
    id: string(row.id),
    name: string(row.name),
    reason: string(row.reason),
    enabled: row.enabled === undefined ? true : boolean(row.enabled),
    createdAt: number(row.createdAt),
  };
}
function filtered(value: unknown): FilteredRecord {
  const row = object(value);
  return {
    userId: string(row.userId),
    screenName: optionalString(row.screenName),
    lists: strings(row.lists),
    at: number(row.at),
  };
}
function overlay(value: unknown): OverlayRecord {
  const row = object(value);
  const lists = strings(row.lists);
  const byList = row.evidence === undefined ? undefined : Object.fromEntries(
    Object.entries(object(row.evidence)).map(([id, value]) => {
      if (!lists.includes(id)) return invalid();
      return [id, evidence(value)];
    }),
  );
  return {
    userId: string(row.userId),
    screenName: optionalString(row.screenName),
    lists,
    addedAt: number(row.addedAt),
    evidence: byList,
    tweetId: optionalString(row.tweetId),
    tweetUrl: url(row.tweetUrl),
  };
}
function allowed(value: unknown): AllowRecord {
  const row = object(value);
  return {
    userId: string(row.userId),
    screenName: optionalString(row.screenName),
    at: number(row.at),
  };
}
function outbox(value: unknown): OutboxRecord {
  const row = object(value);
  const attempts = number(row.attempts);
  if (!Number.isSafeInteger(attempts)) return invalid();
  // 数据库自增主键只属于来源设备，合并时按举报内容去重，不能跨设备复用主键。
  return {
    userId: string(row.userId),
    screenName: optionalString(row.screenName),
    listId: string(row.listId),
    tweetId: string(row.tweetId),
    tweetUrl: url(row.tweetUrl),
    tweetText: row.tweetText === undefined
      ? undefined
      : typeof row.tweetText === "string"
      ? row.tweetText
      : invalid(),
    createdAt: number(row.createdAt),
    attempts,
    lastError: optionalString(row.lastError),
  };
}

export function parseEnvelope(value: unknown): BackupEnvelope {
  const row = object(value);
  if (row.version !== 1) return invalid();
  const encrypted = boolean(row.encrypted);
  return {
    version: 1,
    encrypted,
    exportedAt: number(row.exportedAt),
    data: string(row.data),
    salt: encrypted ? string(row.salt) : undefined,
    iv: encrypted ? string(row.iv) : undefined,
  };
}

export function parsePayload(value: unknown): BackupPayload {
  const row = object(value);
  const config = object(row.config);
  const data = object(row.data);
  if (row.version !== 1 || data.version !== 1) return invalid();
  const locale = config.locale;
  if (
    locale !== undefined && locale !== "auto" && locale !== "en" && locale !== "zh" &&
    locale !== "ja" && locale !== "ru"
  ) return invalid();
  const localLists = config.localLists === undefined
    ? undefined
    : array(config.localLists, localList);
  if (localLists && new Set(localLists.map((list) => list.id)).size !== localLists.length) {
    return invalid();
  }
  return {
    version: 1,
    exportedAt: number(row.exportedAt),
    accountKey: row.accountKey === null ? null : string(row.accountKey),
    config: {
      subscriptions: strings(config.subscriptions),
      enabled: boolean(config.enabled),
      localLists,
      onlineSubmission: config.onlineSubmission === undefined
        ? undefined
        : boolean(config.onlineSubmission),
      locale,
    },
    data: {
      version: 1,
      exportedAt: number(data.exportedAt),
      filtered: array(data.filtered, filtered),
      overlay: array(data.overlay, overlay),
      allow: array(data.allow, allowed),
      outbox: array(data.outbox, outbox),
    },
  };
}
