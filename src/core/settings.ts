/**
 * 扩展配置的形状与默认值。
 *
 * 与 `config.ts` 分开：这里只有**纯数据**（形状、默认值、每一项的含义），不依赖 storage，
 * 因此判定规则（`submission.ts`）与单测都能直接引用它；`config.ts` 只管读写与归一化。
 */
import { ONLINE_SUBMISSION_DEFAULT } from "./submission.ts";

/** 界面语言：auto 跟随浏览器，其余是受支持的语言代码。 */
export type LocaleSetting = "auto" | "en" | "zh" | "ja" | "ru";

/**
 * 用户自己建的列表。
 *
 * 它首先是**用户自己的名单**：创建即在本机可用、可订阅、可举报，条目不出设备。
 * 名称与理由会交一份给服务端留作记录（平台据此收集，是否发展成在线列表由管理员决定），
 * 这件事不改变它在本地的工作方式 —— 关掉「在线提交」后连这份记录也不交。
 */
export interface LocalList {
  /** 客户端生成的 UUID；若日后被采纳为在线列表，沿用的就是它。 */
  id: string;
  /** 用户自己写的名称，原文，不做多语言化。 */
  name: string;
  /** 用户自己写的理由，原文。 */
  reason: string;
  /**
   * 是否生效。
   *
   * 这是本地列表的"勾选"：停用之后它不再隐藏账号、也不出现在屏蔽理由弹窗里，
   * 但条目原样留着 —— 与订阅列表的勾选是同一个动作，含义都是"这条名单现在算不算数"。
   */
  enabled: boolean;
  createdAt: number;
}

export interface ExtensionConfig {
  /** 已订阅的列表 ID。 */
  subscriptions: string[];
  /** 总开关。 */
  enabled: boolean;
  /**
   * 是否向服务端提交（举报、自建列表的名称与理由、按需申请的账号）。
   *
   * 关闭后扩展只从服务端读取，其余全部在本机完成；判断见 `submission.ts`。
   */
  onlineSubmission: boolean;
  /** 界面语言，默认跟随浏览器。 */
  locale: LocaleSetting;
  /** 用户自建的本地列表。 */
  localLists: LocalList[];
  /** WebDAV 配置。 */
  webdav: {
    enabled: boolean;
    url: string;
    username: string;
    password: string;
    /** 加密口令；为空表示明文上传。 */
    passphrase: string;
  };
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  subscriptions: [],
  localLists: [],
  enabled: true,
  onlineSubmission: ONLINE_SUBMISSION_DEFAULT,
  locale: "auto",
  webdav: {
    enabled: false,
    url: "",
    username: "",
    password: "",
    passphrase: "",
  },
};

/**
 * 把存储里的原始配置归一化成当前形状：缺失的键补默认值、**只保留当前定义的键**。
 *
 * 两件事都要做对：
 * - 缺键补默认值 —— 老版本存下来的配置里没有 `onlineSubmission`，必须补成默认值（开启），
 *   否则老用户升级后会静默变成"只读"，而他们什么都没改过；
 * - 多余键丢掉 —— 选项会随版本增删，留下的旧键会跟着导出文件与 WebDAV 同步漂到别的设备上。
 *
 * 纯函数（不吃 storage），因此这些语义可以直接单测。`config.ts` 的读写都过它。
 */
export function normalizeConfig(raw: unknown): ExtensionConfig {
  const stored = (raw ?? {}) as Partial<ExtensionConfig> &
    Record<string, unknown>;
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (stored[key] !== undefined) merged[key] = stored[key];
  }
  const localLists = normalizeLocalLists(stored.localLists);
  const localIds = new Set(localLists.map((list) => list.id));
  return {
    ...(merged as unknown as ExtensionConfig),
    webdav: { ...DEFAULT_CONFIG.webdav, ...(stored.webdav ?? {}) },
    localLists,
    // 不变量：订阅里只有服务器列表。本地列表走本地判定，绝不进网络路径 ——
    // 早前的版本把它写进了订阅，于是同步器拿一个服务器不存在的 id 去问，界面报"列表不存在"。
    subscriptions: [...new Set(stored.subscriptions ?? [])].filter((id) =>
      !localIds.has(id)
    ),
  };
}

/** 本地列表只保留形状正确的记录：存储可能来自旧版本或被手工改过。 */
function normalizeLocalLists(raw: unknown): LocalList[] {
  if (!Array.isArray(raw)) return [];
  const lists: LocalList[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { id, name, reason, createdAt, enabled } = item as Record<
      string,
      unknown
    >;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof name !== "string" || typeof reason !== "string") continue;
    lists.push({
      id,
      name,
      reason,
      // 早先的版本没有这个字段：那时创建的列表就是生效的，补 true 才不会把老用户的名单停掉。
      enabled: enabled !== false,
      createdAt: Number(createdAt) || Date.now(),
    });
  }
  return lists;
}
