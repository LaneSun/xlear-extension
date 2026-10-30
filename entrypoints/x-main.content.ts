/**
 * 页面环境的内容脚本（`world: "MAIN"`，`document_start`）。
 *
 * 它只做一件事：把渲染出的帖子映射成 `data-xlear-*` 属性，供隔离世界的过滤引擎读取。
 * 两个世界共享 DOM，所以不需要消息通道。
 */
import { defineContentScript } from "wxt/utils/define-content-script";
import { installScanner } from "../src/x/scanner.ts";
import { X_MATCHES } from "../src/x/selectors.ts";

export default defineContentScript({
  matches: X_MATCHES,
  runAt: "document_start",
  world: "MAIN",
  main() {
    installScanner();
  },
});
