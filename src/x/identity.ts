/** 只读 React 帖子对象：兼容归一化对象与移动布局使用的结果包装，不遍历引用帖。 */
export interface TweetIdentity {
  tweetId: string;
  userId: string;
  screenName?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{1,20}$/.test(value)
    ? value
    : undefined;
}

export function tweetIdentity(value: unknown): TweetIdentity | null {
  let tweet = record(value);
  // TweetWithVisibilityResults / TweetResult 只解包本条，不递归 quoted_status_result。
  for (let depth = 0; tweet && depth < 4; depth++) {
    const legacy = record(tweet.legacy);
    const tweetId = id(tweet.rest_id) ?? id(tweet.id_str) ?? id(legacy?.id_str);
    const core = record(tweet.core);
    const results = record(core?.user_results);
    const result = record(results?.result);
    const user = record(tweet.user) ?? record(result?.user) ?? result;
    const userLegacy = record(user?.legacy);
    const userCore = record(user?.core);
    const userId = id(user?.id_str) ?? id(user?.rest_id) ??
      id(userLegacy?.id_str);
    const name = user?.screen_name ?? userCore?.screen_name ??
      userLegacy?.screen_name;
    if (tweetId && userId) {
      return {
        tweetId,
        userId,
        screenName:
          typeof name === "string" && /^[A-Za-z0-9_]{1,15}$/.test(name)
            ? name
            : undefined,
      };
    }
    tweet = record(tweet.tweet) ?? record(tweet.result);
  }
  return null;
}
