/** 浏览器回归：只操作独立本地夹具，绝不访问用户的 X 会话。 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(path.join(root, "node_modules/wxt/package.json"));
const { build } = require("esbuild");
const { chromium } = await import(process.env.XLEAR_PLAYWRIGHT ?? "playwright");
const output = process.env.XLEAR_QA_OUTPUT ?? "/tmp/xlear-mobile-qa";
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export { installScanner } from './src/x/scanner.ts';
    export { installFilter } from './src/x/filter.ts';
    export { showReasonDialog } from './src/x/dialog.ts';
    export { installBlockMenuInterceptor, startBlockOnX } from './src/x/blockmenu.ts';
    export { applyLocale, t } from './src/i18n.content.ts';`,
    resolveDir: root,
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "xlear",
  target: "chrome140",
});
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.XLEAR_CHROMIUM,
});
const errors = [];
const results = [];
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
});
await context.route(
  "https://xlear.test/**",
  (route) =>
    route.fulfill({
      body: "<!doctype html><html><body></body></html>",
      contentType: "text/html",
    }),
);
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
const reset = async () => {
  await page.goto("https://xlear.test/");
  await page.setContent(
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#fff"></head>
    <body style="margin:0; font-family:Arial; background:white"><main></main><div id="layers"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
};
const setup = async (locale, width, height, tag = "div") => {
  await reset();
  await page.setViewportSize({ width, height });
  await page.evaluate(({ locale, tag }) => {
    xlear.applyLocale(locale);
    window.matches = 0;
    window.blocked = new Set(["1"]);
    window.counts = [];
    window.makeTweet = (id, userId, cell, tagName = tag) => {
      const tweet = document.createElement(tagName);
      tweet.dataset.testid = "tweet";
      tweet.id = `tweet-${id}`;
      tweet.style.cssText =
        "box-sizing:border-box;border:1px solid #ccc;padding:16px;min-height:180px";
      const content = document.createElement("div");
      content.setAttribute("aria-hidden", "false");
      const avatar = document.createElement("span");
      avatar.textContent = "Avatar";
      avatar.style.cssText = "position:relative;z-index:10";
      content.append(avatar);
      const link = document.createElement("a");
      link.href = `https://x.com/author${userId}/status/${id}`;
      const time = document.createElement("time");
      time.textContent = "1m";
      link.append(time);
      const text = document.createElement("p");
      text.dataset.testid = "tweetText";
      text.textContent = "Original post " + id;
      const caret = document.createElement("button");
      caret.dataset.testid = "caret";
      caret.textContent = "More";
      content.append(link, text, caret);
      tweet.append(content);
      tweet.__reactFiber$fixture = {
        memoizedProps: {
          tweet: {
            rest_id: id,
            user: { rest_id: userId, screen_name: `author${userId}` },
          },
        },
      };
      (cell ?? document.querySelector("main")).append(tweet);
      return tweet;
    };
    const cell = document.createElement("div");
    cell.dataset.testid = "cellInnerDiv";
    document.querySelector("main").append(cell);
    makeTweet("101", "1", cell);
    makeTweet("102", "2", cell);
    makeTweet("103", "1");
    window.stopScanner = xlear.installScanner();
    window.filter = xlear.installFilter({
      match: async (ids) => {
        matches++;
        return new Map(
          ids.filter((id) => blocked.has(id)).map((
            id,
          ) => [id, { lists: ["list"] }]),
        );
      },
      allow: async (id) => {
        blocked.delete(id);
      },
      countHidden: (ids) => counts.push(...ids),
      blockOnX: async () => "Test failure visible",
      listName: () => "Long list name / Очень длинное название списка",
      strings: () => ({
        text: xlear.t("card.text", { user: "{user}", lists: "{lists}" }),
        textNoHandle: xlear.t("card.textNoHandle", { lists: "{lists}" }),
        show: xlear.t("card.show"),
        neverHide: xlear.t("card.neverHide"),
        neverHideConfirm: xlear.t("card.neverHideConfirm", { user: "{user}" }),
        neverHideConfirmAction: xlear.t("card.neverHide"),
        cancel: xlear.t("common.cancel"),
        block: xlear.t("card.blockOnX"),
        listSeparator: xlear.t("card.listSeparator"),
      }),
    });
  }, { locale, tag });
  await page.waitForFunction(() =>
    document.querySelectorAll('[data-xlear-filtered="hidden"]').length === 2
  );
};
try {
  for (const locale of ["en", "zh", "ja", "ru"]) {
    for (
      const [width, height] of [[320, 568], [390, 844], [844, 390], [1280, 800]]
    ) {
      await setup(locale, width, height, width < 600 ? "div" : "article");
      const metrics = await page.evaluate(() => {
        const tweet = document.querySelector("#tweet-103");
        const card = tweet.querySelector("[data-xlear-card]");
        const rect = card.getBoundingClientRect();
        return {
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          cardHeight: rect.height,
          tweetHeight: tweet.getBoundingClientRect().height,
          minButtonHeight: Math.min(
            ...[...card.querySelectorAll("button")].map((button) =>
              button.getBoundingClientRect().height
            ),
          ),
          clipped: card.scrollWidth > card.clientWidth,
          contentOpacity: getComputedStyle(tweet.firstElementChild).opacity,
          otherVisible: getComputedStyle(document.querySelector("#tweet-102"))
                .visibility === "visible" &&
            !document.querySelector("#tweet-102").hasAttribute(
              "data-xlear-filtered",
            ),
        };
      });
      assert.equal(
        metrics.pageOverflow,
        false,
        `${locale}/${width} page overflow`,
      );
      assert.equal(metrics.clipped, false, `${locale}/${width} clipped card`);
      assert.equal(
        metrics.contentOpacity,
        "0",
        "positioned avatar must not bleed through the card",
      );
      assert.equal(
        metrics.otherVisible,
        true,
        "shared cell must preserve other author",
      );
      assert.ok(metrics.minButtonHeight >= 44);
      assert.ok(Math.abs(metrics.cardHeight - metrics.tweetHeight) <= 2);
      results.push({ locale, width, ...metrics });
      if (width === 390 && locale === "en") {
        await page.screenshot({
          path: path.join(output, "mobile-filter.png"),
          fullPage: true,
        });
      }
      await page.locator("#tweet-103 .xlear-actions button").nth(2).click();
      await page.waitForFunction(() =>
        document.querySelector("#tweet-103 .xlear-error").textContent.includes(
          "failure",
        )
      );
      await page.locator("#tweet-103 .xlear-actions button").first().click();
      assert.equal(
        await page.locator("#tweet-103 [data-xlear-overlay]").count(),
        0,
      );
      assert.equal(
        await page.locator("#tweet-103 > div").getAttribute("aria-hidden"),
        "false",
      );
      assert.equal(await page.locator("#tweet-103 [inert]").count(), 0);
    }
  }
  // 身份复用、失去 fiber、原始 aria/inert 状态、负缓存与销毁。
  await setup("en", 390, 844);
  const before = await page.evaluate(() => matches);
  await page.waitForTimeout(3300);
  assert.equal(
    await page.evaluate(() => matches),
    before,
    "negative matches must be cached",
  );
  await page.evaluate(() => {
    const tweet = document.querySelector("#tweet-101");
    tweet.__reactFiber$fixture = {
      memoizedProps: { tweet: { rest_id: "104", user: { rest_id: "2" } } },
    };
    tweet.querySelector("a").href = "/other/status/104";
  });
  await page.waitForFunction(() =>
    !document.querySelector("#tweet-101").hasAttribute("data-xlear-filtered")
  );
  assert.equal(
    await page.locator("#tweet-101 [data-xlear-overlay]").count(),
    0,
  );
  await page.evaluate(() => {
    const tweet = document.querySelector("#tweet-103");
    delete tweet.__reactFiber$fixture;
    tweet.querySelector("p").textContent = "Unknown author";
  });
  await page.waitForFunction(() =>
    !document.querySelector("#tweet-103").hasAttribute("data-xlear-user")
  );
  assert.equal(
    await page.locator("#tweet-103 [data-xlear-overlay]").count(),
    0,
  );
  // 新移动页没有 testid，props 是 Relay fragment，实体在 hook 的 snapshot.data。
  await page.evaluate(() => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("role", "link");
    wrapper.setAttribute("data-href", "https://m.x.com/mobile/status/201");
    const article = document.createElement("article");
    article.id = "relay-post";
    article.textContent = "Mobile Relay post";
    article.__reactFiber$fixture = {
      memoizedProps: {},
      return: {
        memoizedProps: { tweet: { __id: "fragment-reference" } },
        memoizedState: {
          memoizedState: null,
          next: {
            memoizedState: {
              snapshot: {
                data: {
                  rest_id: "201",
                  core: {
                    user_results: {
                      result: {
                        user: { rest_id: "1", core: { screen_name: "mobile" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    wrapper.append(article);
    document.querySelector("main").append(wrapper);
  });
  await page.waitForFunction(() =>
    document.querySelector("#relay-post").getAttribute("data-xlear-user") ===
      "1"
  );
  await page.waitForFunction(() =>
    document.querySelector("#relay-post").hasAttribute("data-xlear-filtered")
  );
  assert.equal(
    await page.locator("#relay-post .xlear-actions button").count(),
    2,
  );
  // 失去作者时仍必须清除全部旧标记与遮罩。
  assert.equal(await page.locator("#tweet-103 [inert]").count(), 0);
  await page.evaluate(() => {
    filter.destroy();
    stopScanner();
  });
  assert.equal(await page.locator("#xlear-style").count(), 0);

  // 晚到的旧匹配结果不能覆盖刷新后的放行结果。
  await setup("en", 390, 844);
  await page.evaluate(() => {
    filter.destroy();
    window.replies = [];
    filter = xlear.installFilter({
      match: () => new Promise((resolve) => replies.push(resolve)),
      allow: async () => {},
      countHidden: () => {},
      blockOnX: async () => null,
      listName: () => "list",
      strings: () => ({
        text: "{user} {lists}",
        textNoHandle: "{lists}",
        show: "Show",
        neverHide: "Allow",
        neverHideConfirm: "Allow?",
        neverHideConfirmAction: "Allow",
        cancel: "Cancel",
        block: "Block",
        listSeparator: ",",
      }),
    });
  });
  await page.waitForFunction(() => replies.length === 1);
  await page.evaluate(() => filter.refresh());
  await page.waitForFunction(() => replies.length === 2);
  await page.evaluate(() => {
    replies[1](new Map());
    replies[0](new Map([["1", { lists: ["list"] }]]));
  });
  await page.waitForTimeout(100);
  assert.equal(await page.locator("[data-xlear-filtered]").count(), 0);
  // 扫描器缺席时，稍后插入的新帖子也必须由看门狗恢复可见。
  await page.evaluate(() => {
    stopScanner();
    const orphan = document.createElement("article");
    orphan.id = "orphan";
    orphan.textContent = "Unknown layout";
    document.querySelector("main").append(orphan);
  });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector("#orphan")).visibility ===
        "visible",
    null,
    { timeout: 4000 },
  );

  // 短屏弹窗、长列表、四语言、焦点循环与取消恢复。
  for (const locale of ["en", "zh", "ja", "ru"]) {
    await reset();
    await page.setViewportSize({ width: 320, height: 300 });
    await page.evaluate((locale) => {
      xlear.applyLocale(locale);
      const before = document.createElement("button");
      before.id = "before";
      before.textContent = "Before";
      document.body.append(before);
      before.focus();
      window.dialogResult = null;
      void xlear.showReasonDialog({
        screenName: "author",
        lists: Array.from(
          { length: 20 },
          (_, i) => ({
            id: String(i),
            name: "Long name",
            reason: "Long reason ".repeat(6),
          }),
        ),
        strings: {
          title: xlear.t("dialog.title", { user: "{user}" }),
          ariaLabel: xlear.t("dialog.ariaLabel"),
          confirm: xlear.t("dialog.confirm"),
          processing: xlear.t("dialog.processing"),
          cancel: xlear.t("common.cancel"),
        },
      }).then((result) => {
        dialogResult = result;
      });
    }, locale);
    const sheet = page.locator("#xlear-dialog-host .sheet");
    const box = await sheet.boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 301);
    const cancel = page.locator("#xlear-dialog-host button").last();
    const cancelBox = await cancel.boundingBox();
    assert.ok(cancelBox.y + cancelBox.height <= 300);
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page.evaluate(() =>
        document.querySelector("#xlear-dialog-host").shadowRoot.activeElement
          .className
      ),
      "ghost",
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => dialogResult.kind), "cancel");
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "before",
    );
    assert.equal(await page.locator("body > [inert]").count(), 0);
  }

  // 移动底部面板只有 role=button、确认框只有 role=alertdialog，验证实际点击链。
  await setup("en", 390, 844);
  await page.evaluate(() => {
    filter.destroy();
    window.nativeConfirmed = 0;
    window.submitted = [];
    window.overlays = [];
    xlear.installBlockMenuInterceptor({
      lists: () => [{ id: "one", name: "Spam", reason: "Spam reason" }],
      addOverlay: async (...args) => overlays.push(args),
      submit: async (...args) => {
        submitted.push(args);
        return null;
      },
    });
    const caret = document.querySelector("#tweet-102 [data-testid=caret]");
    caret.addEventListener("click", () => {
      const block = document.createElement("button");
      block.dataset.testid = "block";
      block.textContent = "Block";
      document.querySelector("#layers").append(block);
      block.addEventListener("click", () => {
        block.remove();
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "alertdialog");
        for (const kind of ["Confirm", "Cancel"]) {
          const button = document.createElement("button");
          button.dataset.testid = "confirmationSheet" + kind;
          button.textContent = kind;
          button.addEventListener("click", () => {
            if (kind === "Confirm") nativeConfirmed++;
            dialog.remove();
          });
          dialog.append(button);
        }
        document.querySelector("#layers").append(dialog);
      });
    });
  });
  // 用户点到菜单以外以后，旧帖子的上下文必须作废。
  await page.locator("#tweet-102 [data-testid=caret]").click();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.locator("[data-testid=block]").click();
  await page.waitForTimeout(120);
  assert.equal(await page.locator("#xlear-dialog-host").count(), 0);
  await page.locator("[data-testid=confirmationSheetCancel]").click();
  await page.locator("#tweet-102 [data-testid=caret]").click();
  await page.locator("[data-testid=block]").click();
  await page.locator("#xlear-dialog-host input").first().check();
  await page.screenshot({ path: path.join(output, "mobile-dialog.png") });
  await page.locator("#xlear-dialog-host button").first().click();
  await page.waitForFunction(() => submitted.length === 1);
  assert.deepEqual(
    await page.evaluate(() => ({
      confirmed: nativeConfirmed,
      user: submitted[0][0].userId,
      tweet: submitted[0][2].id,
      overlays: overlays.length,
    })),
    { confirmed: 1, user: "2", tweet: "102", overlays: 1 },
  );
  assert.equal(await page.locator("#layers.xlear-suppress").count(), 0);
  // 用户取消不产生本地覆盖或举报；原生按钮消失也不能伪报成功。
  await page.locator("#tweet-102 [data-testid=caret]").click();
  await page.locator("[data-testid=block]").click();
  await page.locator("#xlear-dialog-host button").last().click();
  await page.waitForFunction(() =>
    !document.querySelector("[role=alertdialog]")
  );
  assert.deepEqual(
    await page.evaluate(
      () => [nativeConfirmed, submitted.length, overlays.length],
    ),
    [1, 1, 1],
  );
  await page.locator("#tweet-102 [data-testid=caret]").click();
  await page.locator("[data-testid=block]").click();
  await page.locator("#xlear-dialog-host input").first().check();
  await page.evaluate(() =>
    document.querySelector("[data-testid=confirmationSheetConfirm]").remove()
  );
  await page.locator("#xlear-dialog-host button").first().click();
  await page.waitForFunction(() =>
    !document.querySelector("#xlear-dialog-host")
  );
  assert.deepEqual(
    await page.evaluate(
      () => [nativeConfirmed, submitted.length, overlays.length],
    ),
    [1, 1, 1],
  );
  assert.equal(await page.locator("#layers.xlear-suppress").count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(
    {
      pass: true,
      layouts: results.length,
      results,
      scenarios: [
        "shared cell",
        "no cell",
        "node reuse",
        "unknown author",
        "negative cache",
        "stale response",
        "visible errors",
        "short viewport",
        "focus trap",
        "mobile block flow",
        "watchdog",
        "cancel block",
        "missing native confirmation",
        "positioned avatar",
        "dismissed menu context",
      ],
      screenshots: output,
    },
    null,
    2,
  ));
} finally {
  await browser.close();
}
