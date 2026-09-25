/**
 * WebDAV 同步与导出/导入。
 *
 * 需求：用户可以在别的设备上恢复数据，密钥一起带过去，但之后两端不再自动同步。
 * 因此这里是"推一份 / 拉一份"的显式操作，默认还会用口令加密（密钥本身也在里面）。
 */
import { loadAccountKey, loadConfig, patchConfig, saveAccountKey, type ExtensionConfig } from "../core/config.ts";
import { exportAll, importAll, type ExportBundle } from "../core/storage.ts";

const FILE_NAME = "xlear-sync.json";
const PBKDF2_ITERATIONS = 250_000;

interface Envelope {
  version: 1;
  encrypted: boolean;
  exportedAt: number;
  salt?: string;
  iv?: string;
  data: string;
}

interface SyncPayload {
  version: 1;
  exportedAt: number;
  config: Pick<
    ExtensionConfig,
    "subscriptions" | "enabled"
  >;
  accountKey: string | null;
  data: Omit<ExportBundle, "config" | "accountKey">;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 返回 ArrayBuffer 支撑的视图：WebCrypto 的 BufferSource 不接受 SharedArrayBuffer。 */
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function seal(payload: SyncPayload, passphrase: string): Promise<Envelope> {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload)) as Uint8Array<ArrayBuffer>;
  if (passphrase.length === 0) {
    return {
      version: 1,
      encrypted: false,
      exportedAt: payload.exportedAt,
      data: toBase64(plaintext),
    };
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    version: 1,
    encrypted: true,
    exportedAt: payload.exportedAt,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(cipher)),
  };
}

async function open(envelope: Envelope, passphrase: string): Promise<SyncPayload> {
  if (!envelope.encrypted) {
    return JSON.parse(new TextDecoder().decode(fromBase64(envelope.data))) as SyncPayload;
  }
  if (!envelope.salt || !envelope.iv) throw new Error("同步文件缺少加密参数");
  const key = await deriveKey(passphrase, fromBase64(envelope.salt));
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.iv) },
      key,
      fromBase64(envelope.data),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as SyncPayload;
  } catch {
    throw new Error("解密失败：口令不正确");
  }
}

function endpoint(config: ExtensionConfig): string {
  const base = config.webdav.url.trim();
  if (base.endsWith(".json")) return base;
  return `${base.replace(/\/+$/, "")}/${FILE_NAME}`;
}

function authHeader(config: ExtensionConfig): Record<string, string> {
  if (config.webdav.username.length === 0) return {};
  const raw = `${config.webdav.username}:${config.webdav.password}`;
  return { authorization: `Basic ${toBase64(new TextEncoder().encode(raw))}` };
}

/** 运行时申请目标域的访问权限（Chrome/Firefox 都要求用户手势）。 */
async function buildPayload(config: ExtensionConfig): Promise<SyncPayload> {
  const data = await exportAll();
  return {
    version: 1,
    exportedAt: Date.now(),
    config: {
      subscriptions: config.subscriptions,
      enabled: config.enabled,
    },
    accountKey: await loadAccountKey(),
    data,
  };
}

export async function testWebdav(config: ExtensionConfig): Promise<{ ok: boolean; message: string }> {
  if (config.webdav.url.trim().length === 0) return { ok: false, message: "还没有填写 WebDAV 地址" };
  try {
    const response = await fetch(endpoint(config), {
      method: "HEAD",
      headers: authHeader(config),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 405) {
      // 有些服务端不支持 HEAD，用 GET 再试一次。
      const retry = await fetch(endpoint(config), {
        method: "GET",
        headers: authHeader(config),
        signal: AbortSignal.timeout(15_000),
      });
      return retry.ok || retry.status === 404
        ? { ok: true, message: "连接正常" }
        : { ok: false, message: `服务端返回 HTTP ${retry.status}` };
    }
    if (response.ok || response.status === 404) return { ok: true, message: "连接正常" };
    return { ok: false, message: `服务端返回 HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function pushToWebdav(config: ExtensionConfig): Promise<{ ok: boolean; message: string }> {
  if (config.webdav.url.trim().length === 0) return { ok: false, message: "还没有填写 WebDAV 地址" };
  try {
    const payload = await buildPayload(config);
    const envelope = await seal(payload, config.webdav.passphrase);
    const response = await fetch(endpoint(config), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...authHeader(config),
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return { ok: false, message: `上传失败：HTTP ${response.status}` };
    return { ok: true, message: `已上传（${envelope.encrypted ? "已加密" : "明文"}）` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 从 WebDAV 拉取并合并。
 * 集合取并集；配置只在本地还是"空壳"（没有任何订阅）时才采用远端，避免覆盖本地偏好。
 */
export async function pullFromWebdav(config: ExtensionConfig): Promise<{ ok: boolean; message: string }> {
  if (config.webdav.url.trim().length === 0) return { ok: false, message: "还没有填写 WebDAV 地址" };
  try {
    const response = await fetch(endpoint(config), {
      method: "GET",
      headers: authHeader(config),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return { ok: false, message: "远端还没有同步文件" };
    if (!response.ok) return { ok: false, message: `下载失败：HTTP ${response.status}` };
    const envelope = await response.json() as Envelope;
    const payload = await open(envelope, config.webdav.passphrase);
    return await mergePayload(payload, config);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function mergePayload(
  payload: SyncPayload,
  config: ExtensionConfig,
): Promise<{ ok: boolean; message: string }> {
  await importAll(payload.data);
  const subscriptions = [...new Set([...config.subscriptions, ...payload.config.subscriptions])];
  await patchConfig({ subscriptions });
  if (payload.accountKey && (await loadAccountKey()) === null) {
    await saveAccountKey(payload.accountKey);
  }
  return {
    ok: true,
    message: `已合并：订阅 ${payload.config.subscriptions.length} 个列表，条目 ${payload.data.filtered.length} 条`,
  };
}

/** 导出成本地文件内容（供 options 页下载）。 */
export async function exportToFile(passphrase: string): Promise<string> {
  const config = await loadConfig();
  const payload = await buildPayload(config);
  const envelope = await seal(payload, passphrase.length > 0 ? passphrase : config.webdav.passphrase);
  return JSON.stringify(envelope, null, 2);
}

export async function importFromFile(
  content: string,
  passphrase: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const envelope = JSON.parse(content) as Envelope;
    const payload = await open(envelope, passphrase);
    const config = await loadConfig();
    return await mergePayload(payload, config);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 清空账号密钥（配合 clearAll 使用）。 */