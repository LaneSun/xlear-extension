/**
 * 「在线提交」开关的语义。
 *
 * 关闭后扩展**只读不写**：照常同步列表、照常在本机隐藏与记录，但不向服务端发任何写请求 ——
 * 举报（连同按需申请的账号）、自建列表的名称与理由都不再上传。
 *
 * 规则只写在这一个地方：传输层（`api.ts` 的写路径）与界面都调 `submissionsAllowed()`，
 * 判断不会分叉。新增任何会写服务端的功能时，走 `api.ts` 的写路径即可自动受它约束。
 */

/** 默认开启：分享过滤信息是这个产品的前提，关掉要用户自己动手。 */
export const ONLINE_SUBMISSION_DEFAULT = true;

/**
 * 这次配置允许向服务端提交吗。
 *
 * 参数只取一个字段，因此调用点（配置对象、状态对象、测试里的字面量）都能直接传。
 */
export function submissionsAllowed(
  config: { onlineSubmission: boolean },
): boolean {
  return config.onlineSubmission;
}

/** 写请求被这个开关拦下时抛出：调用点据此区分「用户关掉了」与「真的失败了」。 */
export class SubmissionDisabledError extends Error {
  constructor() {
    super("online submission is disabled");
    this.name = "SubmissionDisabledError";
  }
}
