# GitHub Release 与应用更新

## 正式更新源

git-knot 只使用 GitHub Releases：

```text
https://github.com/tisrop/git-knot/releases/latest/download/latest.json
```

Tauri updater 公钥固定在：

- `src-tauri/tauri.conf.json`
- `scripts/release/update-policy.mjs`

私钥不得提交到仓库。当前本地密钥文件位于：

```text
~/.config/git-knot/keys/updater.key
~/.config/git-knot/keys/updater.key.password
```

应将其内容分别保存为 GitHub Actions Secrets：

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

完成 GitHub Secrets 配置并确认备份后，可以删除本地密码明文文件；私钥和密码必须保留安全备份，否则已安装版本无法验证后续更新。

## 发布流程

1. 同步以下三个版本号：
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
2. 运行完整检查：

   ```bash
   pnpm run check
   pnpm run build
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

3. 创建并推送与版本一致的 Tag：

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

4. `.github/workflows/release.yml` 将：
   - 校验 Tag 与三个 manifest 版本；
   - 构建 macOS Intel、macOS Apple Silicon、Linux x86_64 和 Windows x86_64；
   - 使用 updater 私钥签名安装包；
   - 生成并上传 `latest.json`；
   - 在发布前运行 `validate:github-release`；
   - 校验通过后把草稿 Release 发布为正式版本。

## 本地签名构建

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.config/git-knot/keys/updater.key")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$HOME/.config/git-knot/keys/updater.key.password")"
pnpm tauri build
```

不得把环境变量、私钥或密码写入仓库文件、日志或构建产物。

## 更新运行时

前端只能通过 `DesktopApi.updates` 使用更新能力：

- `check`：检查 `latest.json`；
- `downloadAndInstall`：重新检查目标版本，下载、验证签名并安装；
- `subscribeProgress`：监听下载和安装阶段；
- `restart`：安装成功后重启应用。

React 不直接依赖 updater 插件。Rust 命令负责：

- 限制请求 ID 和版本格式；
- 防止并发安装；
- 安装前重新检查并比对用户确认的版本；
- 限制更新说明长度；
- 把网络、平台、签名和安装错误映射为稳定中文提示。

## Windows 便携版

当前自动更新面向 Tauri 正式安装包。Windows 便携 ZIP 仍采用下载后手动覆盖，不允许运行中的便携程序自替换。若后续发布便携版，必须在 Release 元数据中使用独立资产，并继续通过 `validate:github-release` 校验其规范 GitHub 下载地址。

## 配置安全检查

```bash
pnpm run check:update-policy
```

该检查要求：

- `bundle.active=true`；
- `createUpdaterArtifacts=true`；
- updater endpoint 唯一指向 `tisrop/git-knot`；
- 公钥与正式 git-knot updater 公钥完全一致；
- Rust 端存在 `tauri-plugin-updater`；
- React 不直接依赖 `@tauri-apps/plugin-updater`；
- 配置中不存在 Gitee 更新地址。
