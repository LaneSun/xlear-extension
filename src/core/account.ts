/**
 * 账号：按需申请，密钥只存在本地。
 *
 * 需求是「只订阅不提交则不需要账号」，因此只有用户第一次提交举报时才会走到这里。
 * 密钥由服务端生成并只返回一次，这里存进 storage.local，随导出一起迁移。
 */
import { createAccount, fetchMe } from "./api.ts";
import { clearAccountKey, loadAccountKey, saveAccountKey } from "./config.ts";

/**
 * 保证有一个可用的账号密钥。
 *
 * 关键点是**校验**：本地存着的密钥可能早已失效（服务端数据被清理、账号被封禁、备份回滚）。
 * 失效时的表现是"静默失败"：弹窗照常写本地覆盖、帖子照常被隐藏，
 * 而举报其实 401 进了 outbox 并在 5 次重试后被丢弃，用户毫无察觉。
 * 因此这里用一次轻量的 `GET /api/account/me` 校验；失效就换一把新密钥（队列里的举报会自动重试成功）。
 */
export async function ensureAccount(): Promise<string> {
  const existing = await loadAccountKey();
  if (existing) {
    if (await isKeyUsable(existing)) return existing;
    // 失效：清掉旧密钥重新申请。旧密钥不可恢复。
    await clearAccountKey();
  }
  const created = await createAccount();
  await saveAccountKey(created.key);
  return created.key;
}

/** 本轮 service worker 生命周期内的校验结果缓存，避免每次提交都多打一次请求。 */
let keyCheck: { key: string; ok: boolean } | null = null;

async function isKeyUsable(key: string): Promise<boolean> {
  if (keyCheck?.key === key) return keyCheck.ok;
  try {
    await fetchMe(key);
    keyCheck = { key, ok: true };
    return true;
  } catch (error) {
    // 网络故障不代表密钥失效：只有服务端明确说"密钥无效/账号被封"才换密钥。
    const status = (error as { status?: number })?.status;
    const ok = status !== 401 && status !== 403;
    keyCheck = { key, ok };
    return ok;
  }
}
