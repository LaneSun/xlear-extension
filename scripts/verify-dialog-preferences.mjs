/** 新 profile 加载真实扩展，在拦截到本地的 X 夹具验证主题、选择历史与重启持久化。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.XLEAR_PLAYWRIGHT ?? "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.XLEAR_QA_OUTPUT ?? "/tmp/xlear-dialog-qa";
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), "xlear-dialog-profile-"));
const extension = path.join(root, ".output/chrome-mv3");
const ids = {
  spam: "11111111-1111-4111-8111-111111111111",
  clickbait: "22222222-2222-4222-8222-222222222222",
  fraud: "33333333-3333-4333-8333-333333333333",
};
const local = {
  id: ids.clickbait,
  name: "Clickbait",
  reason: "Misleading headlines",
  enabled: true,
  createdAt: 1,
};
let context;
let control;
let serial = 1000;
const errors = [];
const rows = [];
const fixture = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#fff">
<style>body{margin:0;background:#000;color:#e7e9ea;font-family:Arial}main{max-width:600px;margin:auto}article{padding:20px;border:1px solid #333}button{padding:12px}#layers{position:fixed;inset:0;pointer-events:none}#layers button{pointer-events:auto}</style>
</head><body><div id="react-root"><main><h2>Xlear test timeline</h2><article data-testid="tweet"><a><time>1m</time></a><p data-testid="tweetText">A local test post. No X account or network action.</p><button data-testid="caret">More</button></article></main></div><div id="layers"></div>
<script>
const id=new URL(location.href).searchParams.get('id');
const article=document.querySelector('article');
article.querySelector('a').href='https://x.com/fixture/status/'+id;
article.__reactFiber$fixture={memoizedProps:{tweet:{rest_id:id,user:{rest_id:id,screen_name:'fixture'}}}};
window.nativeConfirmed=0;
document.querySelector('[data-testid=caret]').onclick=()=>{
 const block=document.createElement('button'); block.dataset.testid='block'; block.textContent='Block';
 document.querySelector('#layers').append(block);
 block.onclick=()=>{
  block.remove(); const dialog=document.createElement('div');dialog.setAttribute('role','alertdialog');
  for(const kind of ['Confirm','Cancel']){
   const button=document.createElement('button');button.dataset.testid='confirmationSheet'+kind;button.textContent=kind;
   button.onclick=()=>{if(kind==='Confirm')nativeConfirmed++;dialog.remove()};dialog.append(button);
  }
  document.querySelector('#layers').append(dialog);
 };
};
</script></body></html>`;
async function start() {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.XLEAR_CHROMIUM,
    viewport: { width: 390, height: 844 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  await context.route(
    "https://x.com/**",
    (route) => route.fulfill({ body: fixture, contentType: "text/html" }),
  );
  const worker = context.serviceWorkers()[0] ??
    await context.waitForEvent("serviceworker");
  await worker.evaluate(({ ids }) => {
    globalThis.qaRequests = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      qaRequests.push({ path: url.pathname, method: init?.method ?? "GET" });
      if (url.pathname === "/api/lists") {
        return Response.json({
          lists: [
            {
              id: ids.spam,
              name: "Spam",
              reason: "Repetitive promotion",
              version: 0,
              entryCount: 0,
              subscriberCount: 0,
              updatedAt: 1,
            },
            {
              id: ids.fraud,
              name: "Fraud",
              reason: "Deceptive schemes",
              version: 0,
              entryCount: 0,
              subscriberCount: 0,
              updatedAt: 1,
            },
          ],
        });
      }
      if (url.pathname.endsWith("/changes")) {
        return Response.json({
          listId: url.pathname.split("/")[3],
          version: 0,
          minRetainedSeq: 0,
          hasMore: false,
          ops: [],
        });
      }
      throw new Error("Unexpected network request " + url.pathname);
    };
  }, { ids });
  control = await context.newPage();
  await control.goto(
    `chrome-extension://${new URL(worker.url()).hostname}/options.html`,
  );
  return worker;
}
async function send(message) {
  return control.evaluate(
    (message) => chrome.runtime.sendMessage(message),
    message,
  );
}
async function history() {
  return (await send({ type: "reasonHistory" })).history;
}
async function timeline(
  {
    locale = "en",
    width = 390,
    height = 844,
    background = "#000",
    meta = "#fff",
    scheme = "light",
  } = {},
) {
  await send({ type: "updateConfig", patch: { locale } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto("https://x.com/xlear_fixture?id=" + serial++);
  await page.waitForSelector("article[data-xlear-decided]");
  await page.evaluate(({ background, meta }) => {
    document.body.style.background = background;
    document.querySelector('meta[name="theme-color"]').content = meta;
  }, { background, meta });
  await page.locator("[data-testid=caret]").click();
  await page.locator("[data-testid=block]").click();
  await page.locator("#xlear-dialog-host .sheet").waitFor();
  return page;
}
const names = (page) =>
  page.locator("#xlear-dialog-host .name").allTextContents();
const selected = (page) =>
  page.locator("#xlear-dialog-host label").evaluateAll((labels) =>
    labels.filter((label) => label.querySelector("input").checked).map(
      (label) => label.querySelector(".name").textContent,
    )
  );
async function cancel(page) {
  await page.locator("#xlear-dialog-host .actions .ghost").click();
  await page.waitForFunction(() =>
    !document.querySelector("[role=alertdialog]")
  );
}
try {
  let worker = await start();
  await send({
    type: "updateConfig",
    patch: {
      onlineSubmission: false,
      subscriptions: [ids.spam, ids.fraud],
      localLists: [local],
    },
  });
  assert.deepEqual(await history(), { lastUsed: {}, lastSelection: [] });
  let page = await timeline();
  assert.equal(await page.locator("#xlear-dialog-host .reuse").count(), 0);
  assert.equal(
    await page.locator("#xlear-dialog-host .sheet").evaluate((el) =>
      getComputedStyle(el).backgroundColor
    ),
    "rgb(0, 0, 0)",
  );
  for (const name of ["Spam", "Clickbait"]) {
    await page.locator("#xlear-dialog-host label").filter({ hasText: name })
      .locator("input").check();
  }
  await page.locator("#xlear-dialog-host .primary").click();
  await control.waitForFunction(async () =>
    (await chrome.runtime.sendMessage({ type: "reasonHistory" })).history
      .lastSelection.length === 2
  );
  assert.equal(await page.evaluate(() => nativeConfirmed), 1);
  const first = await history();
  assert.deepEqual(
    new Set(first.lastSelection),
    new Set([ids.spam, ids.clickbait]),
  );
  await page.close();

  // 新标签页通过内容脚本重新向后台读取，快捷键只勾选，不会直接提交。
  page = await timeline({ background: "#15202b", locale: "zh" });
  assert.deepEqual(await names(page), ["Clickbait", "Spam", "Fraud"]);
  assert.deepEqual(await selected(page), []);
  await page.locator("#xlear-dialog-host .reuse").click();
  assert.deepEqual(await selected(page), ["Clickbait", "Spam"]);
  assert.equal(await page.evaluate(() => nativeConfirmed), 0);
  assert.deepEqual(await history(), first);
  await page.screenshot({
    path: path.join(output, "dialog-dim-zh.png"),
    animations: "disabled",
  });
  assert.equal(
    await page.locator("#xlear-dialog-host input:checked").first().evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    ),
    "rgb(29, 155, 240)",
  );
  await cancel(page);
  assert.deepEqual(await history(), first);
  await page.close();

  // 上次选了多项，部分停用时仍可复用其余可用项。
  await send({
    type: "updateConfig",
    patch: { localLists: [{ ...local, enabled: false }] },
  });
  page = await timeline();
  await page.locator("#xlear-dialog-host .reuse").click();
  assert.deepEqual(await selected(page), ["Spam"]);
  await cancel(page);
  await page.close();
  await send({ type: "updateConfig", patch: { localLists: [local] } });

  // 最近使用的理由排首位，其他理由保留自己的上次使用时间。
  page = await timeline();
  await page.locator("#xlear-dialog-host label").filter({ hasText: "Fraud" })
    .locator("input").check();
  await page.locator("#xlear-dialog-host .primary").click();
  await control.waitForFunction(
    async (id) =>
      (await chrome.runtime.sendMessage({ type: "reasonHistory" })).history
        .lastSelection[0] === id,
    ids.fraud,
  );
  const second = await history();
  assert.ok(second.lastUsed[ids.fraud] > second.lastUsed[ids.spam]);
  await page.close();

  // 黑、暗蓝、浅色，与工具栏 meta 冲突或只有 rgb meta；四语言含短屏。
  const themes = [
    {
      background: "#000",
      meta: "#fff",
      expected: "rgb(0, 0, 0)",
      scheme: "light",
    },
    {
      background: "#15202b",
      meta: "#fff",
      expected: "rgb(21, 32, 43)",
      scheme: "light",
    },
    {
      background: "#fff",
      meta: "#000",
      expected: "rgb(255, 255, 255)",
      scheme: "dark",
    },
    {
      background: "transparent",
      meta: "rgb(21, 32, 43)",
      expected: "rgb(21, 32, 43)",
      scheme: "light",
    },
  ];
  for (const locale of ["en", "zh", "ja", "ru"]) {
    for (
      const [width, height] of [[320, 300], [390, 844], [844, 390], [1280, 800]]
    ) {
      for (const theme of themes) {
        page = await timeline({ locale, width, height, ...theme });
        assert.deepEqual(await names(page), ["Fraud", "Clickbait", "Spam"]);
        const metric = await page.locator("#xlear-dialog-host .sheet").evaluate(
          (el) => {
            const box = el.getBoundingClientRect();
            const buttons = [...el.querySelectorAll("button")].map((button) => {
              const r = button.getBoundingClientRect();
              return { height: r.height, right: r.right, bottom: r.bottom };
            });
            return {
              background: getComputedStyle(el).backgroundColor,
              color: getComputedStyle(el).color,
              right: box.right,
              bottom: box.bottom,
              top: box.top,
              overflow: el.scrollWidth > el.clientWidth,
              buttons,
            };
          },
        );
        assert.equal(metric.background, theme.expected);
        assert.equal(metric.overflow, false);
        assert.ok(
          metric.top >= 0 && metric.right <= width && metric.bottom <= height,
        );
        assert.ok(
          metric.buttons.every((b) =>
            b.height >= 44 && b.right <= width && b.bottom <= height
          ),
        );
        await page.locator("#xlear-dialog-host .reuse").click();
        assert.deepEqual(await selected(page), ["Fraud"]);
        if (width === 390 && locale === "en" && theme.background === "#000") {
          await page.screenshot({
            path: path.join(output, "dialog-dark-en.png"),
            animations: "disabled",
          });
        }
        rows.push({ locale, width, height, ...metric });
        await cancel(page);
        await page.close();
      }
    }
  }

  page = await timeline();
  // 弹窗保持打开时切换主题，包含 react-root 实际背景与系统媒体条件变化。
  await page.evaluate(() => {
    document.body.style.background = "#15202b";
  });
  await page.waitForFunction(() =>
    getComputedStyle(
      document.querySelector("#xlear-dialog-host").shadowRoot.querySelector(
        ".sheet",
      ),
    ).backgroundColor === "rgb(21, 32, 43)"
  );
  await page.evaluate(() => {
    document.querySelector("#react-root").style.background = "#fff";
  });
  await page.waitForFunction(() =>
    getComputedStyle(
      document.querySelector("#xlear-dialog-host").shadowRoot.querySelector(
        ".sheet",
      ),
    ).backgroundColor === "rgb(255, 255, 255)"
  );
  await page.evaluate(() => {
    document.body.style.background = "transparent";
    document.querySelector("#react-root").style.background = "transparent";
    document.querySelector('meta[name="theme-color"]').remove();
    for (const [scheme, color] of [["light", "#fff"], ["dark", "#000"]]) {
      const meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.media = "(prefers-color-scheme: " + scheme + ")";
      meta.content = color;
      document.head.append(meta);
    }
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() =>
    getComputedStyle(
      document.querySelector("#xlear-dialog-host").shadowRoot.querySelector(
        ".sheet",
      ),
    ).backgroundColor === "rgb(0, 0, 0)"
  );
  await cancel(page);
  await page.close();
  assert.deepEqual(await history(), second);

  // X 原生确认缺失时不生成历史。
  page = await timeline();
  await page.locator("#xlear-dialog-host label").filter({ hasText: "Spam" })
    .locator("input").check();
  await page.evaluate(() =>
    document.querySelector("[data-testid=confirmationSheetConfirm]").remove()
  );
  await page.locator("#xlear-dialog-host .primary").click();
  await page.waitForFunction(() =>
    !document.querySelector("#xlear-dialog-host")
  );
  assert.deepEqual(await history(), second);
  await page.close();

  // 退订上次唯一理由后不显示快捷键；停用本地理由也不能被历史带回。
  await send({
    type: "updateConfig",
    patch: {
      subscriptions: [ids.spam],
      localLists: [{ ...local, enabled: false }],
    },
  });
  page = await timeline();
  assert.deepEqual(await names(page), ["Spam"]);
  assert.equal(await page.locator("#xlear-dialog-host .reuse").count(), 0);
  await cancel(page);
  await page.close();
  await send({
    type: "updateConfig",
    patch: { subscriptions: [ids.spam, ids.fraud], localLists: [local] },
  });

  // 只清测试 profile 的脚本缓存；保留存储，重启实际浏览器验证持久化。
  assert.ok(
    (await worker.evaluate(() => qaRequests)).every((r) => r.method === "GET"),
  );
  await context.close();
  await rm(path.join(profile, "Default/Service Worker"), {
    recursive: true,
    force: true,
  });
  await rm(path.join(profile, "Default/Code Cache/js"), {
    recursive: true,
    force: true,
  });
  worker = await start();
  assert.deepEqual(await history(), second);
  page = await timeline();
  assert.deepEqual(await names(page), ["Fraud", "Clickbait", "Spam"]);
  await page.locator("#xlear-dialog-host .reuse").click();
  assert.deepEqual(await selected(page), ["Fraud"]);
  await cancel(page);
  await page.close();
  // 历史更新与计数更新并发不能互相覆盖；清空本机数据也清空选择记录。
  await control.evaluate(async ({ ids }) =>
    Promise.all([
      chrome.runtime.sendMessage({ type: "countHidden", userIds: ["90001"] }),
      chrome.runtime.sendMessage({
        type: "submitReport",
        userId: "90002",
        tweetId: "90002",
        listIds: [ids.spam],
      }),
    ]), { ids });
  assert.ok(
    (await send({ type: "status" })).counters.hiddenAccounts.includes("90001"),
  );
  assert.deepEqual((await history()).lastSelection, [ids.spam]);
  await send({ type: "clearAll" });
  assert.deepEqual(await history(), { lastUsed: {}, lastSelection: [] });
  assert.deepEqual(errors, []);
  const result = {
    pass: true,
    layouts: rows.length,
    realBuiltExtension: true,
    nativeConfirmationFixture: true,
    cancelPreservesHistory: true,
    restartPersistence: true,
    concurrentStorageWrites: true,
    themeChangesWhileOpen: true,
    noServiceWrites: true,
    clearAllResetsHistory: true,
    rows,
  };
  await writeFile(
    path.join(output, "dialog-results.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify({ ...result, rows: undefined }, null, 2));
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
