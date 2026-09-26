# 发版

产物、校验和与 Release 都由同一套脚本产出：**本地跑得通，CI 就跑得通**。

## 一把钥匙 = 一个扩展 ID

Chromium 系的 `.crx` 必须签名，而**扩展 ID 就是签名公钥的哈希**。所以：

- 私钥一旦固定，就必须一直用同一把；换钥匙等于换 ID，已安装的用户不会自动升级。
- 私钥**不进仓库**（`.gitignore` 里有 `*.pem`），本地留在 `~/.local/share/xlear/crx-key.pem`，
  CI 里放仓库 secret `CRX_KEY`（内容就是那份 PEM 全文）。
- **离线备份这份私钥**。它丢了不影响已发布的包，但之后不能再产出同一个 ID 的 crx。

首次准备：

```bash
openssl genrsa -out ~/.local/share/xlear/crx-key.pem 2048
chmod 600 ~/.local/share/xlear/crx-key.pem
gh secret set CRX_KEY --repo LaneSun/xlear-extension < ~/.local/share/xlear/crx-key.pem
```

## 发一个版本

平时**不往 main 上堆**：每次开发开一个 `dev-<主题>` 书签，在其中提交并推送
（`jj bookmark create dev-<主题> -r @` → `jj git push --bookmark dev-<主题>`）。
只有维护者明确要求升版本时，才走下面这条路径 —— 版本号也只在那一刻改。

```bash
# 1) 维护者明确要求升版本后：改 package.json 的 version（清单版本跟着它走）
# 2) 本地出一遍产物，确认能打包、能装
pnpm run pack

# 3) 把 main 推进到要发布的提交并推送（= 合并到主分支）
jj bookmark set main -r @
jj git push --bookmark main

# 4) 打标签并推送 → CI 自动建 Release 并挂产物
git tag vX.Y.Z && git push origin vX.Y.Z
```

发完版后从新的 main 再开开发分支继续（`jj new main` → `jj bookmark create dev-<下一个主题> -r @`）。

`v*` 标签推上去后，`.github/workflows/release.yml` 会：装依赖 → 用 secret 里的私钥 →
`pnpm run pack` → `gh release create`（附自动生成的 release notes）。

## 产物

| 文件 | 用途 |
| --- | --- |
| `xlear-extension-X.Y.Z-chrome.zip` | Chrome 系商店上传 / 自托管解压加载 |
| `xlear-extension-X.Y.Z.xpi` | Firefox 安装包（**未签名**，见下） |
| `xlear-extension-X.Y.Z.crx` | Chromium 系自托管安装包（CRX3，已签名） |
| `xlear-extension-X.Y.Z-sources.zip` | 商店审核要求的源码包 |
| `SHA256SUMS` | 上面每个文件的校验和 |

## AMO 签名（让 Firefox 正式版也能装）

Firefox 正式版只安装 AMO 签名的扩展，未签名的 xpi 只能进 Developer Edition / Nightly。签名有两条路，
官方文档的关键区别是：**只有 `--channel=unlisted` 会把签好名的文件交给我们**
（`listed` 是往公开列表提交新版本，签名文件由 AMO 托管）。

### 一、随 Release 自动签（已接好）

`.github/workflows/release.yml` 在建 Release 前会尝试用 AMO 凭据给 firefox 构建签名，产物以
`…-signed.xpi` 挂进 Release —— 这个文件在**正式版 Firefox 里可以直接安装**。

启用它只需两件事（都在你这边）：

1. AMO → Developer Hub → API keys 生成凭据（JWT issuer / secret）。
2. 仓库 Settings → Secrets → Actions 添加 `AMO_API_KEY`、`AMO_API_SECRET`。

没配置时这一步会打印一条 notice 并跳过（签名是加成，不该挡发布）。同一个版本号
在 AMO 只能签一次，因此重跑同一次发布的工作流时这一步会失败 —— 所以它设了 allow-failure。

### 二、上架 AMO（listed，按需手动）

公开列表页由这条路创建/更新，需要审核；签名后的 xpi 由 AMO 托管（不会返回本地文件）：

```bash
npx web-ext sign \
  --api-key "$AMO_API_KEY" --api-secret "$AMO_API_SECRET" \
  --source-dir .output/firefox-mv3 \
  --channel=listed \
  --upload-source-code .output/xlear-extension-X.Y.Z-sources.zip \
  --approval-timeout=0        # 提交后立刻返回，不等审核；签名完成后 AMO 会发邮件
```

要点：
- 首次执行会**创建**列表页（ID 用清单里的 `xlear@anlbrain.com`，之后不可改）。
- 版本号必须**严格递增**；同一个版本不能重复提交。
- 我们的构建是打包过的，AMO 会要求源码 —— 所以必须带 `--upload-source-code`（`pnpm run pack` 已经
  产出那个 `-sources.zip`）。
- 提交前可本地预检：`npx web-ext lint --source-dir .output/firefox-mv3`
  （当前结果：0 错误 / 3 警告 —— 警告都是打包进去的依赖里的 `innerHTML` 赋值，我们自己的源码没有）。

## 安装说明（也写在 README 里）

- **xpi 未签名**：Firefox 正式版默认只装 AMO 签名的扩展。要装这份包，需要
  Firefox Developer Edition / Nightly（`about:config` → `xpinstall.signatures.required=false`），
  或先在 AMO 做一次签名。发布到 AMO 时上传 `-firefox.zip`（或 `.xpi`）。
- **crx 是自托管包**：Chrome 默认拦截商店外的 crx 安装，需要
  `ExtensionInstallForcelist`/`ExtensionSettings` 策略，或拖到 `chrome://extensions` 后确认。
- **扩展 ID**：Firefox 的 ID 写在清单里（`browser_specific_settings.gecko.id`，当前
  `xlear@anlbrain.com`），开发加载与发布包是同一个。Chromium 系的 ID 来自签名钥匙的公钥哈希
  （当前 `jphaecjdabihkdhglojhfihdhnbibmci`），而 `pnpm dev` / 解压加载时的 ID 由目录路径决定，
  与发布包**不同** —— 这是正常的，但要迁就它就别换钥匙、也别改目录名。
