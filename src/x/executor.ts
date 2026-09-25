/**
 * 点击工具：拦截用户自己点「屏蔽」时复用 X 的菜单与确认流程。
 *
 * 设计要点：**不自己构造 X 的接口请求**。点击 X 自己的菜单项与确认按钮，
 * 让 X 的前端发出请求，因此不需要逆向它随时会变的签名与请求头。
 * 期间用 `#layers` 上的抑制类把 X 的菜单与弹窗藏起来，避免界面闪动。
 */
import { SEL } from "./selectors.ts";

export const SUPPRESS_CLASS = "xlear-suppress";

/** 轮询等待条件成立。 */
export async function waitFor<T>(
  probe: () => T | null | undefined,
  timeoutMs = 8_000,
  intervalMs = 100,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) return null;
    const gate = Promise.withResolvers<void>();
    setTimeout(gate.resolve, intervalMs);
    await gate.promise;
  }
}

/** 依次派发 pointer/mouse/click 事件。X 的部分组件依赖 pointerdown。 */
export function simulateClick(element: Element): void {
  const rect = element.getBoundingClientRect();
  const options: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  };
  element.dispatchEvent(new PointerEvent("pointerdown", { ...options, pointerId: 1, isPrimary: true }));
  element.dispatchEvent(new MouseEvent("mousedown", options));
  element.dispatchEvent(new PointerEvent("pointerup", { ...options, pointerId: 1, isPrimary: true }));
  element.dispatchEvent(new MouseEvent("mouseup", options));
  element.dispatchEvent(new MouseEvent("click", options));
}

export function suppressLayers(): void {
  document.getElementById("layers")?.classList.add(SUPPRESS_CLASS);
}

export function unsuppressLayers(): void {
  document.getElementById("layers")?.classList.remove(SUPPRESS_CLASS);
}

/** 关掉可能还开着的菜单（Esc），避免影响用户后续操作。 */
export async function dismissMenu(): Promise<void> {
  const menu = document.querySelector(SEL.menu);
  if (!menu) return;
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
  );
  await waitFor(() => (document.querySelector(SEL.menu) ? null : true), 1_000);
}
