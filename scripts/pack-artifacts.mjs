#!/usr/bin/env node
/**
 * 出发布产物：把 WXT 的构建打成可发布的包。
 *
 *   pnpm run pack
 *
 * 产物（都在 `.output/`）：
 *   xlear-extension-<版本>-chrome.zip    Chrome 系商店上传 / 自托管
 *   xlear-extension-<版本>-firefox.zip   Firefox 未签名包（AMO 上传用）
 *   xlear-extension-<版本>.xpi           Firefox 安装包（同上，改个后缀方便直接装）
 *   xlear-extension-<版本>.crx           Chromium 系自托管安装包（CRX3，用私钥签名）
 *   xlear-extension-<版本>-sources.zip   商店审核用的源码包
 *   SHA256SUMS                           上面每个文件的校验和
 *
 * 签名私钥从 `CRX_KEY_FILE` 读，默认 `~/.local/share/xlear/crx-key.pem`。
 * **没有私钥就直接失败**：同一个扩展 ID 必须始终由同一把钥匙签名，换钥匙等于换 ID，
 * 已安装的用户不会自动升级。本地与 CI 用同一套流程，差别只是私钥从哪来
 * （本地是文件，CI 是 `CRX_KEY` secret → 见 `docs/RELEASING.md`）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, ".output");

/** 读 package.json 的版本：产物名与清单版本都跟着它走。 */
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const base = `${pkg.name}-${pkg.version}`;

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `命令失败（${result.status}）：${command} ${args.join(" ")}`,
    );
  }
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "/var/lib/flatpak/exports/bin/io.github.ungoogled_software.ungoogled_chromium",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  throw new Error(
    "找不到 Chromium 系浏览器（打包 crx 要用它）—— 用 CHROME_BIN 指定路径。",
  );
}

function packCrx(builtDir, target) {
  const keyFile = process.env.CRX_KEY_FILE ??
    path.join(os.homedir(), ".local/share/xlear/crx-key.pem");
  if (!fs.existsSync(keyFile)) {
    throw new Error(
      `缺少签名私钥：${keyFile}\n` +
        "每个 crx 都必须由同一把钥匙签名（否则扩展 ID 会变），因此这里不生成临时钥匙。\n" +
        "本地：把私钥放好或设 CRX_KEY_FILE；CI：加仓库 secret CRX_KEY（见 docs/RELEASING.md）。",
    );
  }

  // Chromium 的打包器把 crx 写在**目录旁边**，所以先复制到一个干净的临时目录，
  // 免得 `.output/chrome-mv3.crx` 这种半成品名字混进产物里。
  const staging = path.join(outDir, ".pack");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const dir = path.join(staging, path.basename(builtDir));
  fs.cpSync(builtDir, dir, { recursive: true });

  const chrome = findChrome();
  const args = [
    `--pack-extension=${dir}`,
    `--pack-extension-key=${keyFile}`,
    // 打包不需要界面；CI 上再加 --no-sandbox，免得受 runner 的沙箱限制。
    ...(process.env.CI ? ["--no-sandbox", "--disable-gpu"] : []),
  ];
  const result = spawnSync(chrome, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`打包 crx 失败：${chrome}`);

  const produced = `${dir}.crx`;
  if (!fs.existsSync(produced)) throw new Error(`打包器没有产出 ${produced}`);
  fs.renameSync(produced, target);
  fs.rmSync(staging, { recursive: true, force: true });
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function main() {
  // `wxt zip` 自己会先构建，所以这两条同时产出两套构建目录与 zip。
  run("pnpm", ["run", "zip"]);
  run("pnpm", ["run", "zip:firefox"]);

  const chromeZip = path.join(outDir, `${base}-chrome.zip`);
  const firefoxZip = path.join(outDir, `${base}-firefox.zip`);
  const sourcesZip = path.join(outDir, `${base}-sources.zip`);
  for (const file of [chromeZip, firefoxZip, sourcesZip]) {
    if (!fs.existsSync(file)) throw new Error(`缺少预期产物：${file}`);
  }

  // xpi 就是 Firefox 的 zip，换个后缀便于直接安装。
  const xpi = path.join(outDir, `${base}.xpi`);
  fs.copyFileSync(firefoxZip, xpi);

  const crx = path.join(outDir, `${base}.crx`);
  packCrx(path.join(outDir, "chrome-mv3"), crx);

  const artifacts = [chromeZip, firefoxZip, xpi, crx, sourcesZip];
  const lines = artifacts
    .map((file) => `${sha256(file)}  ${path.basename(file)}`)
    .join("\n");
  fs.writeFileSync(path.join(outDir, "SHA256SUMS"), `${lines}\n`);

  console.log("\n产物：");
  for (const file of artifacts) {
    const size = (fs.statSync(file).size / 1024).toFixed(1);
    console.log(`  ${path.basename(file).padEnd(44)} ${size.padStart(8)} KB`);
  }
  console.log(`  ${"SHA256SUMS".padEnd(44)}（含上面每个文件的校验和）`);
}

main();
