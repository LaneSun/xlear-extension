import { defineConfig } from "wxt";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
// 服务端地址只在 src/core/server.ts 里写一次，清单里的 host_permissions 也从那里取。
import { SERVER_ORIGIN_PATTERN } from "./src/core/server.ts";


export default defineConfig({
  manifestVersion: 3,
  // Preact 走 Vite 预设（WXT 官方的 React 模块是给 React 用的，不适用）。
  vite: () => ({
    plugins: [preact(), tailwindcss()],
  }),
  manifest: {
    name: "Xlear",
    description: "共享的 X 过滤列表：命中名单的账号，帖子会被自动隐藏。",
    // 版本只在 package.json 里写一次（WXT 默认取它，打包文件名也用它）。
    // 标志：白色盾牌 + 中间黑色 X（几何见 shared/logo.ts；PNG 由 assets/logo-solid.svg
    // 渲染，透明底）。
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png",
    },
    action: {
      default_icon: {
        16: "icon/16.png",
        32: "icon/32.png",
        48: "icon/48.png",
        128: "icon/128.png",
      },
    },
    permissions: ["storage", "alarms"],
    host_permissions: [
      "https://x.com/*",
      "https://twitter.com/*",
      // 服务端地址：清单声明一次，运行时就能直接用（Firefox 的 MV3 仍可能没给，见 permissions.ts）。
      SERVER_ORIGIN_PATTERN,
    ],
    // 只有 WebDAV 的目标地址由用户自己填，所以留成运行时申请。
    optional_host_permissions: ["http://*/*", "https://*/*"],
    browser_specific_settings: {
      gecko: {
        id: "xlear@anlbrain.com",
        // 下限取 140：content_scripts 的 world: "MAIN" 要 128，而下面的数据申报要 140
        // （当前 ESR 就在 140 线，旧版本没有升级路径上的必要）。
        strict_min_version: "140.0",
        // Firefox 140+ 要求申报"扩展会把什么传出浏览器"，装的时候据此弹一次同意。
        // 两种都是用户主动点「屏蔽」时提交的那一次动作：帖子的标识与作者（服务端据此
        // 自己抓正文与图片），以及"谁在什么帖子上点了屏蔽"这个交互本身。
        // 除此之外不发别的：没有安装 ID、没有浏览记录、不碰 IP。
        data_collection_permissions: {
          required: ["websiteActivity", "websiteContent"],
        },
      },
      // 声明支持 Firefox for Android（与 gecko 同级）。手机版只跑 X 的**网页版**，
      // 扩展界面（弹窗/选项/首启页）与注入的卡片、理由弹窗都按窄视口做过自适应。
      // 注意正式版 Fenix 只装 AMO 签名的包，没有「临时载入」这条路。
      // Android 侧的 data_collection_permissions 要 142（桌面是 140），所以单独写下限。
      gecko_android: { strict_min_version: "142.0" },
    },
  },
});
