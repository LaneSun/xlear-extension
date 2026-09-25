/**
 * 服务端地址的**唯一出处**。
 *
 * 界面里没有、也不会再有"设置服务端地址"的地方：自托管时改这一行、重新构建即可。
 * `wxt.config.ts` 的 host_permissions 也从这里取值，免得清单与运行时代码各说各话。
 *
 * 这个文件刻意不 import 任何东西 —— 构建配置（Node 侧）也要读它。
 */
export const SERVER_URL = "https://xlear.lanesun.deno.net";

/** 该地址的 match pattern，用于清单的 host_permissions 与运行时权限判断。 */
export const SERVER_ORIGIN_PATTERN = `${new URL(SERVER_URL).origin}/*`;
