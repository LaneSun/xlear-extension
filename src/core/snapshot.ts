/** 严格消费分页 NDJSON：任何截断、错误尾行或不前进的游标都使整次快照失败。 */
import type { SnapshotLine } from "../../contract/types.ts";

export async function readSnapshotPages(
  listId: string,
  fetchPage: (cursor: string | null) => Promise<Response>,
  onRecord: (line: SnapshotLine) => void,
): Promise<number> {
  let cursor: string | null = null;
  let total = 0;
  do {
    const response = await fetchPage(cursor);
    if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`);
    if (!response.body) throw new Error("Snapshot body is missing");
    const reader = response.body.pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    let footer: { next: string | null } | null = null;
    let lastId: string | null = null;
    const line = (raw: string) => {
      if (!raw.trim()) return;
      if (footer) throw new Error("Unexpected data after snapshot footer");
      const parsed: unknown = JSON.parse(raw);
      if (
        !parsed || typeof parsed !== "object" || !("listId" in parsed) ||
        parsed.listId !== listId
      ) {
        throw new Error("Invalid snapshot list");
      }
      if ("error" in parsed) throw new Error("Snapshot stream failed");
      if ("done" in parsed) {
        if (!("nextCursor" in parsed) || typeof parsed.done !== "boolean") {
          throw new Error("Invalid snapshot footer");
        }
        const next = parsed.nextCursor;
        if (
          parsed.done
            ? next !== null
            : typeof next !== "string" || !/^\d{1,20}$/.test(next) ||
              next !== lastId ||
              (cursor !== null && next <= cursor)
        ) {
          throw new Error("Invalid snapshot cursor");
        }
        footer = { next: next as string | null };
        return;
      }
      // 兼容旧服务端曾输出的 addedAt；对外契约统一为 at。
      const at = "at" in parsed
        ? parsed.at
        : "addedAt" in parsed
        ? parsed.addedAt
        : undefined;
      if (
        !("userId" in parsed) || typeof parsed.userId !== "string" ||
        !/^\d{1,20}$/.test(parsed.userId) ||
        typeof at !== "number" || !Number.isFinite(at) || at < 0 ||
        ("screenName" in parsed && typeof parsed.screenName !== "string") ||
        (lastId !== null && parsed.userId <= lastId) ||
        (cursor !== null && parsed.userId <= cursor)
      ) {
        throw new Error("Invalid snapshot entry");
      }
      lastId = parsed.userId;
      onRecord({
        listId,
        userId: parsed.userId,
        at,
        ...("screenName" in parsed
          ? { screenName: parsed.screenName as string }
          : {}),
      });
      total++;
    };
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += chunk.value;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          line(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
        }
        if (buffer.length > 65_536) {
          throw new Error("Snapshot line is too long");
        }
      }
      line(buffer);
      if (!footer) throw new Error("Snapshot was truncated");
      cursor = (footer as { next: string | null }).next;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } while (cursor !== null);
  return total;
}
