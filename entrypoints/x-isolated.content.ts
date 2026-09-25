/**
 * 隔离世界的内容脚本（`document_start`）。
 *
 * 粘合层：把扫描器写在 DOM 属性上的结果接进过滤引擎，把页面上的需求转成后台消息。
 * 所有"要不要做、能不能做"的判断都在后台（包括总开关），这里只负责 DOM。
 */
import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import type { ListSummary } from "../shared/types.ts";
import type { ListsResponse, MatchResponse, SubmitResponse } from "../src/core/messaging.ts";
import { sendMessage } from "../src/core/messaging.ts";
import { applyLocale, t } from "../src/i18n.content.ts";
import { installBlockMenuInterceptor, startBlockOnX } from "../src/x/blockmenu.ts";
import { installFilter } from "../src/x/filter.ts";
import { ATTR, SEL } from "../src/x/selectors.ts";

export default defineContentScript({
  matches: ["https://x.com/*", "https://twitter.com/*"],
  runAt: "document_start",
  main() {
    let listsCache: ListSummary[] = [];
    let subscribedIds: string[] = [];

    const listNames = () => new Map(listsCache.map((list) => [list.id, list.name]));

    /**
     * 理由弹窗只列**用户已订阅**的列表：举报是"我为什么屏蔽它"，
     * 把没订阅的列表摆出来等于让用户替别人做选择。订阅集合来自后台，不在内容脚本里判断。
     */
    const subscribedLists = () => {
      const subscribed = new Set(subscribedIds);
      return listsCache.filter((list) => subscribed.has(list.id));
    };

    const filter = installFilter({
      match: async (userIds) => {
        const response = await sendMessage<MatchResponse>({ type: "match", userIds });
        return new Map(
          response.matches.map((item) => [item.userId, { lists: item.lists }]),
        );
      },
      allow: async (userId, screenName) => {
        await sendMessage({ type: "allow", userId, screenName });
      },
      countHidden: (userIds) => {
        void sendMessage({ type: "countHidden", userIds: [...userIds] });
      },
      listName: (listId) => listNames().get(listId) ?? listId,
      blockOnX: (article) => startBlockOnX(article),
      strings: () => ({
        text: t("card.text", { user: "{user}", lists: "{lists}" }),
        textNoHandle: t("card.textNoHandle", { lists: "{lists}" }),
        show: t("card.show"),
        neverHide: t("card.neverHide"),
        neverHideConfirm: t("card.neverHideConfirm", { user: "{user}" }),
        neverHideConfirmAction: t("card.neverHide"),
        cancel: t("common.cancel"),
        block: t("card.blockOnX"),
        listSeparator: t("card.listSeparator"),
      }),
    });

    installBlockMenuInterceptor({
      lists: () => subscribedLists(),
      submit: async (target, listIds, tweet) => {
        try {
          const response = await sendMessage<SubmitResponse>({
            type: "submitReport",
            userId: target.userId,
            screenName: target.screenName,
            tweetId: tweet.id,
            tweetUrl: tweet.url,
            tweetText: tweet.text,
            listIds,
          });
          if (response.error) return t("dialog.submitFailed", { error: response.error });
          const accepted = response.results.filter((item) => item.status === "accepted").length;
          const duplicate = response.results.filter((item) => item.status === "duplicate").length;
          if (accepted > 0) return t("dialog.submitted", { n: accepted });
          if (duplicate > 0) return t("dialog.duplicate");
          // 到这里就都是"没提交成功"。返回 null 会让用户看到帖子被隐藏、以为举报成功。
          const queued = response.results.find((item) => item.status === "queued");
          if (queued) return t("dialog.submitQueued");
          const rejected = response.results.find((item) => item.status === "rejected");
          if (rejected) return t("dialog.submitFailed", { error: rejected.detail ?? "" });
          return null;
        } catch (error) {
          return t("dialog.submitFailed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      // 本地覆盖：让这次提交立刻对你生效（平台不会马上更新列表）。
      addOverlay: async (userId, screenName, listIds) => {
        await sendMessage({ type: "addOverlay", userId, screenName, listIds });
      },
      // 界面不再显示失败提示，只留在控制台供排查。
      notify: (_userId, message) => {
        console.info("[xlear]", message);
      },
    });



    const refreshLists = async () => {
      try {
        const response = await sendMessage<ListsResponse>({ type: "lists" });
        // 列表名与理由已经按这个语言返回，界面语言必须跟着走，
        // 否则会出现"列表名是俄语、按钮是中文"的混搭。
        applyLocale(response.locale);
        listsCache = response.lists;
        subscribedIds = response.subscriptions;
      } catch {
        // 后台尚未就绪时会失败，稍后重试即可。
      }
    };

    void refreshLists();
    setInterval(() => void refreshLists(), 5 * 60_000);

    browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      const type = (message as { type?: string } | null)?.type;
      // 后台在订阅、语言、本地覆盖或同步结果变化时都会发这一条，统一重算即可。
      if (type === "refresh") {
        void refreshLists().then(() => filter.refresh());
        return undefined;
      }
      if (type === "xlearDiagnose") {
        sendResponse(runDiagnostics());
        return true;
      }
      return undefined;
    });

    /**
     * 选择器自检：X 改版后第一时间能在选项页看到哪一项失效了。
     * 只在打开的 X 页面里跑，因此结果反映的是真实渲染状态。
     */
    function runDiagnostics() {
      const has = (selector: string) => document.querySelector(selector) !== null;
      const tweetCount = document.querySelectorAll(SEL.tweet).length;
      const checked = document.querySelectorAll(`${SEL.tweet}[${ATTR.checked}]`).length;
      const matchedCount = filter.matched().size;
      return {
        url: location.href,
        checks: [
          { name: "帖子容器 article[tweet]", ok: tweetCount > 0, detail: `找到 ${tweetCount} 条` },
          { name: "扫描器标记", ok: checked > 0, detail: `${checked} 条已分类` },
          { name: "更多菜单按钮 caret", ok: has(SEL.caret), detail: "进入任意帖子页或时间线可见" },
          { name: "弹层容器 #layers", ok: has(SEL.layers) },
          { name: "已知过滤命中", ok: true, detail: `本页 ${matchedCount} 个账号命中本地过滤库` },
          { name: "扩展已注入隐藏规则", ok: document.getElementById("xlear-style") !== null },
        ],
      };
    }
  },
});
