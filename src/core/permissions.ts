/**
 * 域名权限。
 *
 * 服务端地址是固定的（见 `server.ts`），已经写进清单的 host_permissions；
 * 但 Firefox 的 MV3 把清单里的 host 权限当"可选项"，装机时可能没给，所以要能就地申请一次。
 * WebDAV 的地址由用户自己填，只能在运行时申请。
 *
 * **`permissions.request` 必须处在用户输入的同步路径上**：Firefox 会报
 * `permissions.request may only be called from a user input handler`，
 * 先 `await permissions.contains(...)` 再申请就已经太晚（手势令牌在第一个 await 处失效）。
 * 因此这里两个函数都不做任何前置 await，调用方必须**在点击处理函数里先拿到 Promise 再等**：
 *
 *     const granted = requestServerPermission();
 *     await granted;   // 任何 await 都放在 request 之后
 */
import { browser } from "wxt/browser";
import { SERVER_ORIGIN_PATTERN } from "./server.ts";

/**
 * 扩展干活需要的全部域名：服务端（拉列表、提交举报）与 X（隐藏帖子）。
 *
 * 两个浏览器都写在清单里，但**Firefox 的 MV3 不把清单里的 host 权限当已授予**：
 * 不请求一次，内容脚本不会跑、"什么都不会发生"，而服务端 fetch 也会被 CORS 挡下。
 * 所以首启页要把这几个域名一起要下来。
 */
const REQUIRED_ORIGINS = [SERVER_ORIGIN_PATTERN, "https://x.com/*", "https://twitter.com/*"];

/** 只查不给：没有手势要求，可以在任意时刻调用。 */
export function hasRequiredOrigins(): Promise<boolean> {
  return browser.permissions.contains({ origins: REQUIRED_ORIGINS });
}

/** 申请全部所需域名（首启页用）。**必须**在用户手势里、任何 await 之前调用。 */
export function requestRequiredOrigins(): Promise<boolean> {
  return browser.permissions.request({ origins: REQUIRED_ORIGINS });
}

/** 只申请服务端域名（popup 的「立即同步」用）。同样是同步路径的要求。 */
export function requestServerPermission(): Promise<boolean> {
  return browser.permissions.request({ origins: [SERVER_ORIGIN_PATTERN] });
}

/** 把用户填的地址转成 match pattern，例如 `https://dav.example.com/*`。 */
function originPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

/** 申请用户填写的域名（WebDAV）。手势力矩的要求同上：调用处必须是点击处理函数的开头。 */
export function requestHostPermission(url: string): Promise<boolean> {
  const pattern = originPattern(url);
  if (!pattern) return Promise.resolve(false);
  return browser.permissions.request({ origins: [pattern] });
}
