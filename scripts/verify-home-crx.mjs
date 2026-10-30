// 验证本地生产首页的四语言布局与 CRX 入口；外部发布页只读。
const { chromium } = await import(process.env.XLEAR_PLAYWRIGHT ?? "playwright");
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = process.env.XLEAR_QA_OUTPUT ?? "/tmp/xlear-dialog-qa";
await mkdir(output, { recursive: true });
const site = process.env.XLEAR_SITE_URL ?? "http://127.0.0.1:8765";
const browser = await chromium.launch({
  executablePath: process.env.XLEAR_CHROMIUM,
  headless: true,
});
const page = await browser.newPage();
const rows = [], errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  for (const lang of ["en", "zh", "ja", "ru"]) {
    for (const width of [320, 390, 844, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      const response = await page.goto(site + "/?lang=" + lang, {
        waitUntil: "networkidle",
      });
      assert.equal(response.status(), 200);
      const button = page.getByRole("link", { name: /Chrome.*CRX/ });
      assert.equal(
        await button.getAttribute("href"),
        "https://github.com/LaneSun/xlear-extension/releases/latest",
      );
      assert.equal(await button.getAttribute("target"), "_blank");
      const metric = await button.evaluate((el) => ({
        lang: document.documentElement.lang,
        text: el.innerText,
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        box: el.getBoundingClientRect().toJSON(),
      }));
      assert.equal(metric.lang, lang);
      assert.ok(metric.scroll <= width);
      assert.ok(
        metric.box.height >= 44 && metric.box.x >= 0 &&
          metric.box.right <= width,
        JSON.stringify(metric),
      );
      rows.push(metric);
      if (lang === "zh" && width === 390) {
        await page.screenshot({
          path: path.join(output, "home-crx-zh.png"),
          fullPage: true,
        });
      }
    }
  }
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: /Chrome.*CRX/ }).click();
  const release = await popupPromise;
  await release.waitForURL(
    /github.com\/LaneSun\/xlear-extension\/releases\/tag\/v/,
  );
  await release.waitForLoadState("domcontentloaded");
  const assets = release.locator('a[href$=".crx"]');
  await assets.first().waitFor({ state: "attached" });
  const asset = await assets.first().getAttribute("href");
  assert.match(asset, /xlear-extension-.*\.crx$/);
  assert.deepEqual(errors, []);
  const result = {
    pass: true,
    layouts: rows.length,
    clickedRelease: release.url(),
    crxAsset: asset,
    rows,
  };
  await writeFile(
    path.join(output, "home-results.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ ...result, rows: undefined }, null, 2));
} finally {
  await browser.close();
}
