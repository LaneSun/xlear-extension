/** 桌面与手机滚动回归：真实扩展 + 本地 X 夹具，不操作任何真实账号。 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.XLEAR_PLAYWRIGHT ?? "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.XLEAR_QA_OUTPUT ?? "/tmp/xlear-scroll-qa";
const audit = process.argv.includes("--audit");
await mkdir(output, { recursive: true });
const listId = "11111111-1111-4111-8111-111111111111";
const results = [];
const fixture =
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;overflow-anchor:none;font-family:Arial}main{max-width:600px;margin:auto}article{box-sizing:border-box;min-height:400px;border:1px solid #888;padding:20px}button,a{min-height:44px;display:inline-flex;align-items:center}#layers{position:fixed;inset:0;pointer-events:none}#layers>*{pointer-events:auto;background:white;border:1px solid #888;padding:20px;position:absolute;top:30%;left:20%;right:20%}</style></head><body><div id="react-root"><main></main><div id="layers"></div></div><script>
window.qa={mode:'overflow',nativeConfirmed:0,focusRedirects:0};
history.scrollRestoration='manual';history.replaceState({view:'home',y:0},'',location.href);
function closeNative(){
 document.querySelector('#layers').replaceChildren();
 document.body.style.overflow='';
 if(qa.mode==='fixed'){document.body.style.position='';document.body.style.top='';document.body.style.width='';scrollTo(0,qa.nativeY)}
}
function render(view){
 document.querySelector('main').replaceChildren();
 for(let i=1;i<=30;i++){
  const article=document.createElement('article');article.id='row-'+i;
  article.innerHTML='<div><a href="/fixture/status/'+(1000+i)+'"><time>'+view+' '+i+'</time></a><p>Long post '+i+'</p><button data-testid="caret">More</button></div>';
  article.__reactFiber$fixture={memoizedProps:{tweet:{rest_id:String(1000+i),user:{rest_id:String(i),screen_name:'fixture'+i}}}};
  document.querySelector('main').append(article);
  article.querySelector('button').onclick=()=>{
   const menu=document.createElement('div');menu.setAttribute('role','menu');
   const block=document.createElement('button');block.dataset.testid='block';block.textContent='Block';menu.append(block);
   if(qa.delayMenu)qa.menuPending=true;else document.querySelector('#layers').append(menu);
   block.onclick=()=>{
    menu.remove();qa.nativeY=scrollY;document.body.style.overflow='hidden';
    if(qa.mode==='fixed'){document.body.style.position='fixed';document.body.style.top=-qa.nativeY+'px';document.body.style.width='100%'}
    const native=document.createElement('div');native.setAttribute('role','alertdialog');
    for(const kind of ['Confirm','Cancel']){const b=document.createElement('button');b.dataset.testid='confirmationSheet'+kind;b.textContent=kind;native.append(b)}
    document.querySelector('#layers').append(native);native.querySelector('button').focus();
   }
  };
 }
}
window.qa.closeNative=closeNative;
document.addEventListener('click',event=>{const b=event.target.closest('[data-testid^=confirmationSheet]');if(b?.closest('[role=alertdialog]')){const confirmed=b.dataset.testid==='confirmationSheetConfirm';if(confirmed)qa.nativeConfirmed++;closeNative();if(confirmed)qa.afterConfirm?.()}});
window.qa.navigate=(view,y=0)=>{
 history.replaceState({...history.state,y:scrollY},'',location.href);history.pushState({view,y},'', '/fixture/'+view);closeNative();render(view);scrollTo(0,y);
};
window.qa.showNewMenu=(hasBlock=true)=>{
 qa.unexpectedBlocks=0;qa.unexpectedEscapes=0;
 const menu=document.createElement('div');menu.id='new-menu';menu.setAttribute('role','menu');
 const item=document.createElement('button');if(hasBlock)item.dataset.testid='block';item.textContent='New page menu';
 item.onclick=()=>qa.unexpectedBlocks++;menu.append(item);document.querySelector('#layers').append(menu);
 document.addEventListener('keydown',event=>{if(event.key==='Escape'){qa.unexpectedEscapes++;menu.remove()}});
};
window.addEventListener('popstate',()=>{closeNative();render(history.state.view);scrollTo(0,history.state.y)});
document.addEventListener('focusin',(event)=>{
 const native=document.querySelector('[role=alertdialog]');
 if(native&&!native.contains(event.target)){qa.focusRedirects++;native.querySelector('button').focus()}
});
render('home');
</script></body></html>`;
for (const mobile of [false, true]) {
  const profile = await mkdtemp("/tmp/xlear-scroll-profile-");
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.XLEAR_CHROMIUM,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    isMobile: mobile,
    hasTouch: mobile,
    args: [
      `--disable-extensions-except=${root}/.output/chrome-mv3`,
      `--load-extension=${root}/.output/chrome-mv3`,
    ],
  });
  const check = (name, pass, metrics) => {
    results.push({ device: mobile ? "mobile" : "desktop", name, pass, ...metrics });
    if (!pass) console.log(JSON.stringify(results.at(-1)));
  };
  try {
    await context.route(
      "https://x.com/**",
      (route) => route.fulfill({ body: fixture, contentType: "text/html" }),
    );
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    await worker.evaluate(({ listId }) => {
      globalThis.fetch = async () => {
        throw Error("Offline fixture");
      };
      return chrome.storage.local.set({
        config: {
          enabled: true,
          onlineSubmission: false,
          locale: "en",
          subscriptions: [],
          localLists: [{
            id: listId,
            name: "Local",
            reason: "Fixture reason",
            enabled: true,
            createdAt: 1,
          }],
        },
      });
    }, { listId });
    const control = await context.newPage();
    await control.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html`);
    const send = (message) =>
      control.evaluate((message) => chrome.runtime.sendMessage(message), message);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const swipe = async () => {
      if (!mobile) {
        await page.mouse.move(5, 600);
        await page.mouse.wheel(0, 450);
      } else {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: 5, y: 600 }],
        });
        for (let y = 550; y >= 250; y -= 50) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: 5, y }],
          });
          await page.waitForTimeout(25);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
      await page.waitForTimeout(200);
    };
    const reset = async () => {
      await send({ type: "clearAll" });
      await page.goto("https://x.com/fixture/home");
      await page.locator("#row-8[data-xlear-decided]").waitFor();
      await page.evaluate(() => scrollTo(0, 2400));
    };
    const metric = () =>
      page.evaluate(() => ({
        y: scrollY,
        root: document.documentElement.style.overflow,
        body: document.body.style.overflow,
        modal: !!document.querySelector("#xlear-dialog-host"),
        inert: !!document.querySelector("#react-root[inert]"),
        focusRedirects: qa.focusRedirects,
      }));
    const menuMetric = () =>
      page.evaluate(() => ({
        blocks: qa.unexpectedBlocks,
        escapes: qa.unexpectedEscapes,
        menu: !!document.querySelector("#new-menu"),
        y: scrollY,
      }));
    const open = async () => {
      await page.locator("#row-7 [data-testid=caret]").click();
      await page.locator("[data-testid=block]").click();
      await page.locator("#xlear-dialog-host .sheet").waitFor();
    };
    const cancel = async () => {
      if (await page.locator("#xlear-dialog-host").count()) {
        await page.locator("#xlear-dialog-host .ghost").click();
      }
      await page.waitForTimeout(150);
    };
    for (const mode of ["overflow", "fixed"]) {
      await reset();
      await page.evaluate((mode) => {
        qa.mode = mode;
      }, mode);
      const before = await metric();
      await open();
      const opened = await metric();
      await swipe();
      const scrolled = await metric();
      await cancel();
      const closed = await metric();
      check(
        "native-lock-" + mode,
        opened.y === scrolled.y && Math.abs(before.y - closed.y) < 2 && !closed.modal &&
          !closed.root && !closed.body,
        { before, opened, scrolled, closed },
      );
    }
    await reset();
    await page.evaluate(() => {
      document.documentElement.style.setProperty("overflow-x", "scroll", "important");
      document.documentElement.style.setProperty("overflow-y", "scroll");
    });
    await open();
    await page.setViewportSize(mobile ? { width: 844, height: 390 } : { width: 900, height: 600 });
    await page.waitForTimeout(150);
    const resized = await page.locator("#xlear-dialog-host .sheet").evaluate((el) => ({
      top: el.getBoundingClientRect().top,
      bottom: el.getBoundingClientRect().bottom,
      height: innerHeight,
    }));
    await cancel();
    const styleRestored = await page.evaluate(() => ({
      y: scrollY,
      xValue: document.documentElement.style.overflowX,
      yValue: document.documentElement.style.overflowY,
      xPriority: document.documentElement.style.getPropertyPriority("overflow-x"),
      yPriority: document.documentElement.style.getPropertyPriority("overflow-y"),
    }));
    check(
      "resize-keeps-position-and-style-priority",
      resized.top >= 0 && resized.bottom <= resized.height + 1 && styleRestored.y === 2400 &&
        styleRestored.xValue === "scroll" && styleRestored.yValue === "scroll" &&
        styleRestored.xPriority === "important" && styleRestored.yPriority === "",
      { resized, styleRestored },
    );
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 });
    await reset();
    await open();
    await page.evaluate(() =>
      history.replaceState({ ...history.state, y: scrollY }, "", location.href)
    );
    await page.waitForTimeout(150);
    const savedHistory = await metric();
    check("same-url-state-update-keeps-dialog", savedHistory.modal && savedHistory.inert, {
      savedHistory,
    });
    if (!savedHistory.modal) {
      await reset();
      await open();
    }
    await page.locator("#xlear-dialog-host input[type=checkbox]").check();
    await page.locator("#xlear-dialog-host .primary").click();
    await page.waitForFunction(() =>
      qa.nativeConfirmed === 1 && !document.querySelector("#xlear-dialog-host")
    );
    await page.waitForTimeout(150);
    const confirmed = await metric();
    check(
      "confirm-does-not-jump-top",
      confirmed.y === 2400 && !confirmed.root && !confirmed.body && !confirmed.inert,
      { confirmed },
    );
    await reset();
    await page.evaluate(() => {
      qa.afterConfirm = () => {
        qa.navigate("confirmed", 500);
        qa.showNewMenu();
      };
    });
    await open();
    await page.locator("#xlear-dialog-host input[type=checkbox]").check();
    await page.locator("#xlear-dialog-host .primary").click();
    await page.waitForTimeout(300);
    const afterConfirm = await menuMetric();
    check(
      "confirmation-does-not-dismiss-new-page-menu",
      afterConfirm.menu && afterConfirm.escapes === 0 && afterConfirm.y === 500,
      { afterConfirm },
    );
    await reset();
    await page.evaluate(() => {
      qa.mode = "fixed";
    });
    await open();
    await page.evaluate(() => qa.closeNative());
    await page.waitForTimeout(200);
    const nativeGone = await metric();
    await cancel();
    const nativeGoneClosed = await metric();
    check(
      "native-close-does-not-jump-top",
      !nativeGone.modal && !nativeGone.inert && nativeGone.y === 2400 &&
        nativeGoneClosed.y === 2400 && !nativeGoneClosed.root && !nativeGoneClosed.body,
      { nativeGone, nativeGoneClosed },
    );
    await reset();
    await open();
    await page.evaluate(() => qa.navigate("detail", 500));
    await page.waitForTimeout(200);
    const navigated = await metric();
    await cancel();
    const released = await metric();
    check(
      "pushState-cancels-old-dialog",
      !navigated.modal && !navigated.inert && navigated.y === 500 && released.y === 500 &&
        !released.body && !released.root,
      { navigated, released },
    );
    await reset();
    await page.evaluate(() => qa.navigate("detail", 2400));
    await page.locator("#row-7[data-xlear-decided]").waitFor();
    await open();
    await page.goBack();
    await page.waitForTimeout(200);
    const back = await metric();
    await cancel();
    const backClosed = await metric();
    check(
      "back-cancels-old-dialog",
      !back.modal && !back.inert && back.y === 2400 && !backClosed.body && !backClosed.root,
      { back, backClosed },
    );
    await page.goForward();
    await page.waitForTimeout(200);
    const forward = await metric();
    check(
      "forward-keeps-native-position",
      forward.y === 2400 && !forward.modal && !forward.inert && !forward.root && !forward.body,
      { forward },
    );
    await reset();
    await worker.evaluate(() => {
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      globalThis.qaRestoreGet = () => {
        chrome.storage.local.get = get;
      };
      chrome.storage.local.get = async (key) => {
        if (key === "runtime") {
          await new Promise((resolve) => {
            globalThis.qaResumeHistory = resolve;
          });
        }
        return get(key);
      };
    });
    await page.locator("#row-7 [data-testid=caret]").click();
    await page.locator("[data-testid=block]").click();
    await worker.evaluate(async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (typeof qaResumeHistory === "function") return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Reason history fixture did not start");
    });
    await page.evaluate(() => qa.navigate("other", 600));
    await worker.evaluate(() => {
      qaRestoreGet();
      qaResumeHistory();
    });
    await page.waitForTimeout(250);
    const delayed = await metric();
    check(
      "late-history-does-not-reopen-dialog",
      !delayed.modal && !delayed.inert && delayed.y === 600 && !delayed.root && !delayed.body,
      { delayed },
    );
    await cancel();
    // 卡片入口等菜单时发生导航，旧请求不能点击或关闭新页面的菜单。
    for (const mode of ["navigate-block", "navigate-empty", "other-menu"]) {
      await reset();
      await send({ type: "addOverlay", userId: "7", listIds: [listId] });
      await page.locator("#row-7 [data-xlear-overlay]").waitFor();
      await page.evaluate(() => {
        qa.delayMenu = true;
      });
      await page.locator("#row-7 .xlear-actions button").last().click();
      await page.waitForFunction(() => qa.menuPending);
      if (mode === "other-menu") {
        await page.evaluate(() => {
          document.querySelector("#row-8 [data-testid=caret]").onclick = () => qa.showNewMenu();
        });
        await page.locator("#row-8 [data-testid=caret]").click();
      } else {
        await page.evaluate((mode) => {
          qa.navigate("new-menu", 500);
          qa.showNewMenu(mode === "navigate-block");
        }, mode);
      }
      await page.waitForTimeout(mode === "navigate-empty" ? 2700 : 300);
      const lateMenu = await menuMetric();
      check(
        "late-menu-preserves-" + mode,
        lateMenu.blocks === 0 && lateMenu.escapes === 0 && lateMenu.menu &&
          lateMenu.y === (mode === "other-menu" ? 2400 : 500),
        { lateMenu },
      );
    }
    await reset();
    const anchorBefore = await page.locator("#row-8").evaluate((el) => ({
      top: el.getBoundingClientRect().top,
      y: scrollY,
    }));
    for (const userId of ["1", "2", "3", "4", "5"]) {
      await send({ type: "addOverlay", userId, listIds: [listId] });
    }
    await page.waitForFunction(() =>
      document.querySelectorAll("[data-xlear-overlay]").length === 5
    );
    await page.waitForTimeout(200);
    const anchorAfter = await page.locator("#row-8").evaluate((el) => ({
      top: el.getBoundingClientRect().top,
      y: scrollY,
    }));
    check("filter-keeps-visible-anchor", Math.abs(anchorBefore.top - anchorAfter.top) < 2, {
      anchorBefore,
      anchorAfter,
    });
    await page.evaluate(() => qa.navigate("detail", 0));
    await page.waitForTimeout(200);
    await page.goBack();
    await page.waitForTimeout(250);
    const restored = await page.locator("#row-8").evaluate((el) => ({
      top: el.getBoundingClientRect().top,
      y: scrollY,
    }));
    check(
      "filtered-timeline-back-restores-reading-position",
      Math.abs(restored.top - anchorAfter.top) < 2 && Math.abs(restored.y - anchorAfter.y) < 2,
      { anchorAfter, restored },
    );
    await page.goForward();
    await page.waitForTimeout(200);
    check("filtered-timeline-forward-keeps-top", (await metric()).y === 0, {
      forward: await metric(),
    });
    await reset();
    await page.evaluate(() => {
      document.documentElement.style.overflowAnchor = "auto";
      document.body.style.overflowAnchor = "auto";
    });
    for (const userId of ["1", "2", "3", "4", "5"]) {
      await send({ type: "addOverlay", userId, listIds: [listId] });
    }
    await page.waitForFunction(() =>
      document.querySelectorAll("[data-xlear-overlay]").length === 5
    );
    await page.waitForTimeout(200);
    const automatic = await page.locator("#row-8").evaluate((el) => ({
      top: el.getBoundingClientRect().top,
      y: scrollY,
    }));
    check("browser-anchor-not-double-corrected", Math.abs(automatic.top - 400) < 2, { automatic });
    for (const userId of ["1", "2", "3", "4", "5"]) await send({ type: "allow", userId });
    await page.waitForFunction(() =>
      document.querySelectorAll("[data-xlear-overlay]").length === 0
    );
    await page.waitForTimeout(200);
    const expanded = await page.locator("#row-8").evaluate((el) => ({
      top: el.getBoundingClientRect().top,
      y: scrollY,
    }));
    check(
      "showing-posts-keeps-reading-position",
      Math.abs(expanded.top - 400) < 2 && expanded.y === 2400,
      { expanded },
    );
    await reset();
    await send({ type: "addOverlay", userId: "7", listIds: [listId] });
    const show = page.locator("#row-7 .xlear-actions button").first();
    await show.waitFor();
    await page.evaluate(() => scrollTo(0, 2420));
    // 点仍在视口内的按钮部分，避免自动化工具先替浏览器滚动整颗按钮。
    const button = await show.boundingBox();
    const point = { x: button.x + button.width / 2, y: Math.max(8, button.y + button.height / 2) };
    if (mobile) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(200);
    const shown = await page.locator("#row-7").evaluate((el) => ({
      top: el.getBoundingClientRect().top,
      y: scrollY,
      hidden: el.hasAttribute("data-xlear-filtered"),
    }));
    check(
      "show-partly-visible-post-without-scrolling-past-it",
      !shown.hidden && shown.y === 2420 && shown.top === -20,
      { shown },
    );
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
console.log(
  JSON.stringify({ cases: results.length, passed: results.filter((row) => row.pass).length }),
);
if (!audit) assert.ok(results.every((row) => row.pass), "滚动与导航回归失败，见 results.json");
