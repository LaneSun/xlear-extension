/** 在全新 profile 加载实际产物，验证扩展页面、后台消息与 IndexedDB；网络用夹具替换。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.XLEAR_PLAYWRIGHT ?? "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.XLEAR_QA_OUTPUT ?? "/tmp/xlear-mobile-qa";
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), "xlear-qa-profile-"));
const extension = path.join(root, ".output/chrome-mv3");
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.env.XLEAR_CHROMIUM,
  viewport: { width: 390, height: 844 },
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
});
const errors = [];
const rows = [];
try {
  const worker = context.serviceWorkers()[0] ??
    await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await worker.evaluate(() => {
    const listId = "11111111-1111-4111-8111-111111111111";
    globalThis.qaCalls = [];
    globalThis.qaStreamFailed = false;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      qaCalls.push({
        path: url.pathname,
        query: url.search,
        method: init?.method ?? "GET",
        credentials: init?.credentials,
      });
      if (url.pathname === "/api/lists") {
        return Response.json({
          lists: [{
            id: listId,
            name: "QA online list",
            reason: "Local fixture",
            version: 2,
            entryCount: 2,
            subscriberCount: 0,
            updatedAt: Date.now(),
          }],
        });
      }
      if (url.pathname.endsWith("/changes")) {
        return Response.json({
          listId,
          version: 2,
          minRetainedSeq: 1,
          hasMore: false,
          ops: [],
        });
      }
      if (url.pathname.endsWith("/snapshot")) {
        const cursor = url.searchParams.get("cursor");
        const rows = cursor
          ? [{ listId, userId: "2", at: 2 }, {
            listId,
            done: true,
            nextCursor: null,
          }]
          : [{ listId, userId: "1", at: 1 }, {
            listId,
            done: false,
            nextCursor: "1",
          }];
        if (qaStreamFailed && cursor) rows[1].error = "stream_failed";
        return new Response(rows.map((row) => JSON.stringify(row)).join("\n"));
      }
      throw new Error("Unexpected request " + url.pathname);
    };
    return chrome.storage.local.set({
      config: {
        enabled: true,
        onlineSubmission: false,
        locale: "en",
        subscriptions: [listId],
        localLists: [{
          id: "22222222-2222-4222-8222-222222222222",
          name: "QA local list",
          reason: "Local reason",
          enabled: true,
          createdAt: Date.now(),
        }],
      },
    });
  });
  await page.goto(`chrome-extension://${id}/options.html`);
  const sync = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: "syncNow", force: true })
  );
  assert.deepEqual(sync.errors, []);
  assert.equal(sync.entries, 2);
  const matches = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: "match", userIds: ["1", "2", "3"] })
  );
  assert.deepEqual(matches.matches.map((m) => m.userId).sort(), ["1", "2"]);
  const calls = await worker.evaluate(() => qaCalls);
  assert.deepEqual(
    calls.filter((c) => c.path.endsWith("/snapshot")).map((c) => c.query),
    [
      "",
      "?cursor=1",
    ],
  );
  assert.ok(calls.every((c) => c.method === "GET" && c.credentials === "omit"));
  // 中途错误不能清空已同步库，也不能把失败记成成功。
  await worker.evaluate(() => {
    qaStreamFailed = true;
  });
  const failure = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: "syncNow", force: true })
  );
  assert.equal(failure.errors.length, 1);
  assert.equal(failure.entries, 2);
  await worker.evaluate(() => {
    qaStreamFailed = false;
  });
  await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: "syncNow", force: true })
  );
  await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: "addOverlay",
      userId: "3",
      screenName: "qa_local",
      listIds: ["22222222-2222-4222-8222-222222222222"],
    })
  );
  for (const locale of ["ru", "en", "zh", "ja"]) {
    await page.evaluate(
      (locale) =>
        chrome.runtime.sendMessage({ type: "updateConfig", patch: { locale } }),
      locale,
    );
    for (const width of [320, 390, 844]) {
      await page.setViewportSize({ width, height: 844 });
      for (
        const file of [
          "popup.html",
          "onboarding.html",
          ...["general", "lists", "local", "data", "diagnostics"].map((tab) =>
            "options.html#" + tab
          ),
        ]
      ) {
        await page.goto(`chrome-extension://${id}/${file}`);
        await page.waitForFunction(() =>
          document.querySelector("#app button") &&
          document.documentElement.lang !== ""
        );
        await page.waitForTimeout(120);
        const metrics = await page.evaluate(() => ({
          overflow: [...document.querySelectorAll("body *")].filter((e) =>
            e.getBoundingClientRect().right > innerWidth + .5 &&
            !e.closest(".xl-tabs")
          ).slice(0, 8).map((e) => ({
            tag: e.tagName,
            class: e.className,
            style: e.getAttribute("style"),
            text: e.textContent.slice(0, 100),
            right: e.getBoundingClientRect().right,
          })),
          scroll: document.documentElement.scrollWidth,
          width: innerWidth,
          text: document.body.innerText.slice(0, 120),
        }));
        assert.ok(
          metrics.scroll <= width,
          `${locale}/${file}/${width}: ${JSON.stringify(metrics)}`,
        );
        rows.push({ locale, width, file });
      }
    }
  }
  await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: "updateConfig",
      patch: { locale: "en", onlineSubmission: false },
    })
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`chrome-extension://${id}/options.html#general`);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  const toggle = page.getByRole("checkbox", { name: "Online submission" });
  await toggle.click();
  await page.waitForFunction(async () =>
    (await chrome.storage.local.get("config")).config.onlineSubmission === true
  );
  await page.waitForFunction(() =>
    document.querySelector(".xl-switch").checked &&
    !document.querySelector(".xl-switch").disabled
  );
  await toggle.click();
  await page.waitForFunction(async () =>
    (await chrome.storage.local.get("config")).config.onlineSubmission === false
  );
  await page.waitForFunction(() =>
    !document.querySelector(".xl-switch").checked &&
    !document.querySelector(".xl-switch").disabled
  );
  await page.reload();
  await page.waitForFunction(() => document.querySelector("select"));
  assert.equal(await toggle.isChecked(), false);
  await page.locator("select").selectOption("ru");
  await page.waitForFunction(() => document.documentElement.lang === "ru");
  assert.equal(
    await page.evaluate(async () =>
      (await chrome.storage.local.get("config")).config.locale
    ),
    "ru",
  );
  await page.screenshot({
    path: path.join(output, "extension-settings-mobile.png"),
    fullPage: true,
  });
  await page.goto(`chrome-extension://${id}/options.html#lists`);
  const localRow = page.locator(".xl-list-row").filter({
    hasText: "QA local list",
  });
  await localRow.waitFor();
  const localText = await localRow.innerText();
  assert.match(localText, /1/);
  const lists = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: "lists" })
  );
  assert.equal(lists.local[0].entries, 1);
  // 退订后即使旧缓存/覆盖还在库里，也不得继续过滤；重新启用后恢复。
  await worker.evaluate(async () => {
    const { config } = await chrome.storage.local.get("config");
    await chrome.storage.local.set({
      config: {
        ...config,
        subscriptions: [],
        localLists: config.localLists.map((list) => ({
          ...list,
          enabled: false,
        })),
      },
    });
  });
  assert.deepEqual(
    await page.evaluate(async () =>
      (await chrome.runtime.sendMessage({
        type: "match",
        userIds: ["1", "2", "3"],
      })).matches
    ),
    [],
  );
  await worker.evaluate(async () => {
    const { config } = await chrome.storage.local.get("config");
    await chrome.storage.local.set({
      config: {
        ...config,
        subscriptions: ["11111111-1111-4111-8111-111111111111"],
        localLists: config.localLists.map((list) => ({
          ...list,
          enabled: true,
        })),
        onlineSubmission: true,
      },
      accountKey: "local-test-key",
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/account/me") return Response.json({});
      if (url.pathname === "/api/reports") {
        const submission = JSON.parse(init.body);
        return Response.json({
          results: submission.listIds.map((listId) => ({
            listId,
            status: submission.target.userId === "4" ? "accepted" : "rejected",
            detail: submission.target.userId,
          })),
        });
      }
      return previousFetch(input, init);
    };
  });
  const concurrent = await page.evaluate(() =>
    Promise.all(
      ["4", "5"].map((userId) =>
        chrome.runtime.sendMessage({
          type: "submitReport",
          userId,
          tweetId: "10" + userId,
          listIds: ["11111111-1111-4111-8111-111111111111"],
        })
      ),
    )
  );
  assert.deepEqual(
    concurrent.map((outcome) => outcome.results.map((result) => result.detail)),
    [[
      "4",
    ], ["5"]],
  );
  assert.deepEqual(concurrent.map((outcome) => outcome.results[0].status), [
    "accepted",
    "rejected",
  ]);
  assert.equal(
    (await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: "outboxList" })
    )).outbox.length,
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        pass: true,
        layouts: rows.length,
        syncEntries: sync.entries,
        snapshotRequests: calls.filter((c) => c.path.endsWith("/snapshot")),
        failedSnapshotPreservesEntries: failure.entries,
        savedSettings: true,
        localEntries: lists.local[0].entries,
        localText,
        inactiveListsExcluded: true,
        concurrentReports: concurrent,
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
