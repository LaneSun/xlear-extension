/** 状态转换回归：六个完整流程覆盖数据合并、同步、采纳与模态交互，全部使用隔离数据。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.XLEAR_PLAYWRIGHT ?? "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.XLEAR_QA_OUTPUT ?? "/tmp/xlear-state-qa";
await mkdir(output, { recursive: true });
const profile = await mkdtemp("/tmp/xlear-state-profile-");
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.env.XLEAR_CHROMIUM,
  viewport: { width: 390, height: 844 },
  args: [
    `--disable-extensions-except=${root}/.output/chrome-mv3`,
    `--load-extension=${root}/.output/chrome-mv3`,
  ],
});
const online = "11111111-1111-4111-8111-111111111111";
const local = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const results = [];
const errors = [];
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).hostname;
  await worker.evaluate(() => {
    globalThis.qa = { offline: true, catalog: [], calls: [], backup: null, reports: [] };
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      qa.calls.push({ path: url.pathname, method: init.method ?? "GET" });
      if (url.hostname === "backup.test") {
        if (init.method === "PUT") {
          qa.backup = init.body;
          return new Response("");
        }
        return new Response(qa.backup);
      }
      if (qa.offline) throw new Error("Offline fixture");
      if (url.pathname === "/api/lists") return Response.json({ lists: qa.catalog });
      if (url.pathname === "/api/account") {
        if (qa.accountOffline) throw new Error("Account service offline");
        return Response.json({ key: "fixture-key" });
      }
      if (url.pathname === "/api/account/me") return Response.json({});
      if (url.pathname === "/api/reports") {
        if (qa.reportsOffline) throw new Error("Report service offline");
        const body = JSON.parse(init.body);
        qa.reports.push(body);
        return Response.json({
          results: body.listIds.map((listId) => ({ listId, status: "accepted" })),
        });
      }
      const list = qa.catalog.find((row) => row.id === url.pathname.split("/")[3]);
      if (url.pathname.endsWith("/changes")) {
        return Response.json({
          listId: list.id,
          version: list.version,
          minRetainedSeq: 0,
          hasMore: false,
          ops: Array.from(
            { length: list.version },
            (_, i) => ({ seq: i + 1, op: "add", userId: String(101 + i), at: 1 }),
          )
            .filter((row) => row.seq > Number(url.searchParams.get("since"))),
        });
      }
      if (url.pathname.endsWith("/snapshot")) {
        return new Response(
          [
            ...Array.from(
              { length: list.version },
              (_, i) => ({ listId: list.id, userId: String(101 + i), at: 1 }),
            ),
            { listId: list.id, done: true, nextCursor: null },
          ].map((row) => JSON.stringify(row)).join("\n"),
        );
      }
      throw new Error("Unexpected fixture " + url.pathname);
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const send = (message) =>
    page.evaluate((message) => chrome.runtime.sendMessage(message), message);
  const localList = (id, enabled = true) => ({
    id,
    name: "Local " + id,
    reason: "Fixture reason",
    enabled,
    createdAt: 1,
  });
  const config = (overrides) =>
    worker.evaluate((config) => chrome.storage.local.set({ config }), {
      enabled: true,
      onlineSubmission: false,
      locale: "en",
      subscriptions: [],
      localLists: [],
      webdav: {
        enabled: true,
        url: "https://backup.test/file.json",
        username: "",
        password: "",
        passphrase: "",
      },
      ...overrides,
    });
  const state = () => worker.evaluate(() => chrome.storage.local.get(["config", "runtime"]));
  const match = async (ids) => (await send({ type: "match", userIds: ids })).matches;
  const add = (userId, listIds) => send({ type: "addOverlay", userId, listIds });
  const catalog = async (ids) => {
    await worker.evaluate((ids) => {
      qa.offline = false;
      qa.catalog = ids.map((id) => ({
        id,
        name: "Online",
        reason: "Fixture",
        version: 1,
        entryCount: 1,
        subscriberCount: 0,
        updatedAt: 1,
      }));
    }, ids);
  };
  const clear = () => send({ type: "clearAll" });

  // 1. 离线冷启动仍能管理本地列表；并发读改写保留全部成员关系。
  await config({ localLists: [localList(local)] });
  await page.goto(`chrome-extension://${id}/options.html#lists`);
  await page.getByText("Local " + local, { exact: true }).waitFor();
  const offline = await send({ type: "lists" });
  assert.equal(offline.local.length, 1);
  assert.ok(offline.catalogError);
  const created = await Promise.all(
    ["A", "B"].map((name) => send({ type: "createLocalList", name, reason: "Fixture" })),
  );
  assert.ok(created.every((row) => (row.id)));
  assert.equal((await state()).config.localLists.length, 3);
  await config({ localLists: [localList(local), localList(other)] });
  for (let n = 0; n < 5; n++) {
    await Promise.all([local, other].map((listId) => add(String(200 + n), [listId])));
  }
  assert.ok((await send({ type: "overlayList" })).overlay.every((row) => row.lists.length === 2));
  results.push("离线本地管理与并发成员写入");

  // 2. 退订仅停用；重新订阅、旧版损坏水位和手动刷新均得到完整名单。
  await clear();
  await config({ subscriptions: [online] });
  await catalog([online]);
  assert.deepEqual((await send({ type: "syncNow" })).errors, []);
  assert.equal((await match(["101"])).length, 1);
  await send({ type: "updateConfig", patch: { subscriptions: [] } });
  assert.equal((await match(["101"])).length, 0);
  await send({ type: "updateConfig", patch: { subscriptions: [online] } });
  await send({ type: "syncNow" });
  assert.equal((await match(["101"])).length, 1);
  await worker.evaluate(() => {
    qa.catalog[0].version = 2;
    qa.calls = [];
  });
  await send({ type: "syncNow" });
  assert.equal((await match(["101", "102"])).length, 2);
  assert.ok(await worker.evaluate(() => qa.calls.some((call) => call.path === "/api/lists")));
  await worker.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("xlear");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction("filtered", "readwrite");
    tx.objectStore("filtered").clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
    db.close();
  });
  await send({ type: "syncNow" });
  assert.equal((await match(["101", "102"])).length, 2);
  results.push("退订重订、旧水位修复与实时同步");

  // 3. 文件和 WebDAV 共用同一合并入口：元数据、成员、允许名单、队列不丢失，重复导入幂等。
  await clear();
  await config({ localLists: [localList(local)] });
  await add("301", [local]);
  await send({ type: "allow", userId: "303", screenName: "allowed" });
  const backup = (await send({ type: "exportBackup", passphrase: "" })).content;
  const payload = JSON.parse(Buffer.from(JSON.parse(backup).data, "base64").toString());
  assert.equal(payload.config.localLists[0].id, local);
  payload.data.outbox = [{
    userId: "305",
    listId: online,
    tweetId: "3005",
    createdAt: 1,
    attempts: 0,
  }];
  const envelope = (data) =>
    JSON.stringify({
      version: 1,
      encrypted: false,
      exportedAt: 1,
      data: Buffer.from(JSON.stringify(data)).toString("base64"),
    });
  const importBackup = (content) => send({ type: "importBackup", content, passphrase: "" });
  await clear();
  await config({ localLists: [localList(other)] });
  await add("302", [other]);
  await send({ type: "allow", userId: "304" });
  for (let n = 0; n < 2; n++) assert.equal((await importBackup(envelope(payload))).ok, true);
  assert.equal((await state()).config.localLists.length, 2);
  assert.equal((await match(["301", "302"])).length, 2);
  assert.equal((await send({ type: "allowList" })).allowed.length, 2);
  assert.equal((await send({ type: "outboxList" })).outbox.length, 1);
  const snapshot = async () =>
    JSON.stringify([
      await state(),
      await send({ type: "overlayList" }),
      await send({ type: "allowList" }),
      await send({ type: "outboxList" }),
    ]);
  const beforeInvalid = await snapshot();
  for (
    const bad of [{ ...payload, data: { ...payload.data, overlay: null } }, {
      ...payload,
      config: { ...payload.config, subscriptions: null },
    }]
  ) {
    assert.equal((await importBackup(envelope(bad))).ok, false);
    assert.equal(await snapshot(), beforeInvalid);
  }
  // 写入中途发生 JS 异常也必须 abort，而非提交前半段写入。
  await worker.evaluate(() => {
    globalThis.qaPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === "overlay" && value.userId === "999") {
        throw new Error("Injected write failure");
      }
      return qaPut.call(this, value, ...args);
    };
  });
  const partial = {
    ...payload,
    data: {
      ...payload.data,
      overlay: [{ userId: "998", lists: [local], addedAt: 1 }, {
        userId: "999",
        lists: [local],
        addedAt: 1,
      }],
    },
  };
  assert.equal((await importBackup(envelope(partial))).ok, false);
  await worker.evaluate(() => {
    IDBObjectStore.prototype.put = qaPut;
  });
  assert.equal(await snapshot(), beforeInvalid);
  const encrypted = (await send({ type: "exportBackup", passphrase: "fixture-password" })).content;
  assert.equal(JSON.parse(encrypted).encrypted, true);
  assert.equal(
    (await send({ type: "importBackup", content: encrypted, passphrase: "wrong" })).ok,
    false,
  );
  assert.equal(await snapshot(), beforeInvalid);
  assert.equal(
    (await send({ type: "importBackup", content: encrypted, passphrase: "fixture-password" })).ok,
    true,
  );
  assert.equal((await send({ type: "webdavSync", direction: "push" })).ok, true);
  assert.equal((await send({ type: "webdavSync", direction: "pull" })).ok, true);
  assert.equal((await match(["301", "302"])).length, 2);
  const legacy = structuredClone(payload);
  delete legacy.config.localLists;
  assert.equal((await importBackup(envelope(legacy))).ok, true);
  assert.equal((await match(["301", "302"])).length, 2);
  results.push("备份完整合并、幂等、旧格式、加密及失败回滚");

  // 4. 在线采纳保留停用状态；启用列表在同一轮同步并按自己的证据提交。
  await clear();
  await config({ localLists: [localList(local, false), localList(other)] });
  await send({ type: "updateConfig", patch: { subscriptions: [] } });
  await add("401", [local]);
  await catalog([local]);
  await send({ type: "syncNow" });
  assert.equal((await state()).config.localLists.length, 1);
  assert.equal((await state()).config.subscriptions.length, 0);
  assert.equal((await match(["401"])).length, 0);
  await config({ localLists: [localList(local), localList(other)], onlineSubmission: true });
  for (const [listId, tweetId] of [[local, "4001"], [other, "4002"]]) {
    await send({ type: "submitReport", userId: "402", listIds: [listId], tweetId });
  }
  await worker.evaluate(() => {
    qa.reports = [];
  });
  const adoption = await send({ type: "syncNow" });
  assert.equal(adoption.lists, 1);
  assert.equal((await match(["101"])).length, 1);
  assert.ok(await worker.evaluate(() => chrome.alarms.get("xlear-sync")));
  const reports = await worker.evaluate(() => qa.reports);
  assert.equal(reports[0].listIds[0], local);
  assert.equal(reports[0].tweet.id, "4001");
  await catalog([local, other]);
  await worker.evaluate(() => {
    qa.reportsOffline = true;
  });
  const retryingAdoption = await send({ type: "syncNow" });
  assert.equal(retryingAdoption.lists, 2);
  assert.deepEqual(retryingAdoption.errors, []);
  assert.equal((await send({ type: "outboxList" })).outbox.length, 1);
  await worker.evaluate(() => {
    qa.reportsOffline = false;
  });
  await send({ type: "flushOutbox" });
  assert.equal((await send({ type: "outboxList" })).outbox.length, 0);
  results.push("本地转在线的开关、首轮同步与证据归属");

  // 5. 长名单详情：滚轮和键盘都不能操作背景，关闭恢复原位置与入口焦点。
  await clear();
  await config({
    localLists: Array.from(
      { length: 35 },
      (_, i) => ({ ...localList("local-" + i), reason: "Long reason. ".repeat(8) }),
    ),
  });
  for (let n = 0; n < 35; n++) await add(String(500 + n), ["local-3"]);
  await page.reload();
  await page.locator(".xl-list-row").nth(3).waitFor();
  await page.locator(".xl-menu-wrap button").nth(3).click();
  const scrollBefore = await page.evaluate(() => scrollY);
  await page.getByRole("menuitem").first().click();
  await page.locator(".xl-entry-row").first().waitFor();
  await page.mouse.move(4, 400);
  await page.mouse.wheel(0, 550);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => scrollY), scrollBefore);
  await page.evaluate(() => {
    document.querySelector(".xl-modal").scrollTop = 99999;
  });
  await page.mouse.move(195, 600);
  await page.mouse.wheel(0, 550);
  await page.waitForTimeout(150);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => scrollY), scrollBefore);
  assert.ok(await page.evaluate(() => document.activeElement.closest(".xl-modal")));
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".xl-modal").count(), 0);
  assert.equal(await page.evaluate(() => scrollY), scrollBefore);
  assert.equal(await page.locator("[inert]").count(), 0);
  assert.equal(
    await page.evaluate(() => document.activeElement.getAttribute("aria-haspopup")),
    "menu",
  );
  results.push("名单弹窗滚动隔离、焦点循环与恢复");

  // 6. 内容脚本加载实际产物；所有 X 请求都由本地夹具响应，无真实账号操作。
  await config({ enabled: false, localLists: [localList(local)] });
  await catalog([online]);
  await send({ type: "lists", force: true });
  await context.route("https://x.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body:
        '<!doctype html><html><body><article><div><a href="/fixture/status/601"><time>now</time></a><button data-testid="caret">More</button></div></article><div id="layers"></div></body></html>',
    }));
  const x = await context.newPage();
  x.on("pageerror", (error) => errors.push(error.message));
  await x.goto("https://x.com/fixture");
  await x.evaluate(() => {
    document.querySelector("article").__reactFiber$fixture = {
      memoizedProps: { tweet: { rest_id: "601", user: { rest_id: "6", screen_name: "fixture" } } },
    };
    document.querySelector("[data-testid=caret]").addEventListener("click", () => {
      const block = document.createElement("button");
      block.dataset.testid = "block";
      block.textContent = "Block";
      document.querySelector("#layers").append(block);
      block.onclick = () => {
        block.remove();
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "alertdialog");
        for (const name of ["Confirm", "Cancel"]) {
          const button = document.createElement("button");
          button.dataset.testid = "confirmationSheet" + name;
          button.textContent = name;
          button.onclick = () => dialog.remove();
          dialog.append(button);
        }
        document.querySelector("#layers").append(dialog);
      };
    });
  });
  await x.waitForFunction(() =>
    document.querySelector("article").getAttribute("data-xlear-user") === "6"
  );
  const openBlock = async () => {
    await x.locator("[data-testid=caret]").click();
    await x.locator("[data-testid=block]").click();
  };
  await openBlock();
  await x.waitForTimeout(150);
  assert.equal(await x.locator("#xlear-dialog-host").count(), 0);
  await x.locator("[data-testid=confirmationSheetCancel]").click();
  await send({ type: "updateConfig", patch: { enabled: true } });
  await x.waitForTimeout(200);
  await openBlock();
  await x.locator("#xlear-dialog-host .sheet").waitFor();
  await send({ type: "updateConfig", patch: { enabled: false } });
  await x.waitForFunction(() =>
    !document.querySelector("#xlear-dialog-host") && !document.querySelector("[role=alertdialog]")
  );
  assert.equal(await x.locator("[inert]").count(), 0);
  // 本地保存不能误报平台复核；混合提交时在线失败仍须在实际页面显示。
  await send({ type: "allow", userId: "6" });
  await send({ type: "updateConfig", patch: { enabled: true } });
  await x.waitForTimeout(200);
  await openBlock();
  await x.locator("#xlear-dialog-host input[type=checkbox]").check();
  await x.locator("#xlear-dialog-host .primary").click();
  const notice = x.locator("[data-xlear-notice] [role=status]");
  await notice.waitFor();
  assert.match(await notice.innerText(), /Saved to 1 local list/);
  assert.doesNotMatch(await notice.innerText(), /review|submission is off/);
  await x.locator("[data-xlear-notice] button").click();
  await worker.evaluate(() => {
    qa.reportsOffline = true;
  });
  await send({
    type: "updateConfig",
    patch: { onlineSubmission: true, subscriptions: [online] },
  });
  await x.waitForTimeout(200);
  await openBlock();
  await x.locator("#xlear-dialog-host input[type=checkbox]").first().waitFor();
  assert.equal(await x.locator("#xlear-dialog-host input[type=checkbox]").count(), 2);
  for (const checkbox of await x.locator("#xlear-dialog-host input[type=checkbox]").all()) {
    await checkbox.check();
  }
  await x.locator("#xlear-dialog-host .primary").click();
  await notice.waitFor();
  assert.match(await notice.innerText(), /Saved to 1 local list/);
  assert.match(await notice.innerText(), /queued/);
  assert.doesNotMatch(await notice.innerText(), /waiting for review/);
  await x.locator("[data-xlear-notice] button").click();
  await worker.evaluate(async () => {
    await chrome.storage.local.remove("accountKey");
    qa.accountOffline = true;
  });
  await openBlock();
  await x.locator("#xlear-dialog-host .reuse").click();
  await x.locator("#xlear-dialog-host .primary").click();
  await notice.waitFor();
  assert.match(await notice.innerText(), /Saved to 1 local list/);
  assert.match(await notice.innerText(), /queued/);
  assert.ok((await send({ type: "outboxList" })).outbox.length > 0);
  await x.screenshot({ path: `${output}/submission-local-and-queued.png` });
  results.push("总开关、理由弹窗取消与本地及在线回执");
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/results.json`,
    JSON.stringify({ pass: true, workflows: results }, null, 2),
  );
  console.log(JSON.stringify({ pass: true, workflows: results }, null, 2));
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
