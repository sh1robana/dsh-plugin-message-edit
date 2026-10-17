# 消息编辑插件适配入口

仅在当前仓库的包名为 `@sh1robana/dsh-plugin-message-edit` 时使用。以下路径均相对仓库根目录；功能约束、源码职责与发布要求以当前 `CLAUDE.md` 为准，版本与测试数量以本次实际读取和执行结果为准。

## 优先检查这些宿主耦合点

- **保存、上下文与历史事件**：沿 `src/index.ts`、`src/shared.ts`、`src/saved-user-messages.ts` 检查会话服务、持久化、投影、分支 seed 与旧协议。当前原地保存依靠替换型 `user/message` 及原事件身份，不能只改聊天显示，或退回会再次请求模型的原生编辑流程。
- **客户端模块与插槽**：检查 `src/client/index.ts`、`UserMessageProjection.tsx`、`transport.ts`、`controller.ts` 使用的服务、聊天条目、事件和刷新机制；与目标宿主实际暴露的接口对照。
- **构建预设**：`scripts/dsh-client-preset.ts` 是本项目维护的客户端预设，不会随 npm 升级自动适配。核对目标宿主的 `window.__ModuleLoader__` 加载契约、静态模块表、external 清单及 purity gate，再核对 manifest 中的客户端注入和 `cordis.patch.yml`。
- **附件、引用和设置**：按实际变更追踪输入框、附件上传、系统文件打开、权限/模型/推理等级与会话引用的宿主服务。实现入口见项目规则中的源码表。

## 构建与测试

先确认 Node.js 满足当前 `package.json` 的要求；依赖缺失或锁文件变更后运行 `npm ci`。完成适配后按顺序执行：

```powershell
npm run build
npm test
```

`build` 包含类型检查，并生成宿主/客户端产物、构建身份和 `src/build-info.ts`。测试会读取生成的 `index.mjs` 和 `client.js`，不能用适配前的产物验证新源码。当前 `targetDshVersion` 由构建脚本从开发依赖 `@deepseek-ai/dsh-session` 读取，应与实际目标运行时核对，不把它当作自动探测桌面版本的结果。

相关行为测试入口：

- `tests/desktop-host.test.mjs`：保存、冷恢复、分支、附件、设置、失败回滚与旧协议。
- `tests/desktop-agent-loop.test.mjs`：真实 Agent/Loop 配合 TestAdapter，检查仅保存不调用模型、保存并发送调用次数。
- `tests/desktop-client.test.mjs`：虚拟模块加载、客户端注入、刷新、会话定位与构建诊断。
- `tests/attachment-editor.test.mjs`、`file-references.test.mjs`、`rich-message-input.test.mjs`、`user-message-projection.test.mjs`：附件、引用、输入与消息投影。

修复缺陷时在对应入口补行为测试，再运行项目要求的检查。这些测试包含 fixture、虚拟加载器和静态渲染，不能代替目标 Electron 宿主实测。

## 获准后安装与检查实际加载

安装前读取当前 `scripts/install-desktop.ps1` 和 `scripts/check-desktop-install.ps1`，确认目标目录与参数。使用已完成构建测试的代码打包：

```powershell
npm pack --ignore-scripts --pack-destination artifacts
```

将本次输出的 tgz 绝对路径传给安装脚本，避免误装旧包。下面的 `AppPath` 是脚本默认值示例，执行前确认实际安装位置：

```powershell
powershell -NoProfile -File ./scripts/install-desktop.ps1 `
  -AppPath 'D:\DeepSeek Harness' `
  -PackagePath '本次生成的 tgz 绝对路径'
```

安装脚本先备份 profile 配置到 `.local-backups/`，再调用目标安装目录内的官方 CLI；不自动重启。安排保存当前工作、彻底退出并重启 DSH，按已有授权由 AI 或维护者完成。

默认数据目录与安装路径适用时运行 `npm run check:installed`。**当前安装脚本遵循 `DSH_HOME`，检查脚本的默认 `ProfilePath` 却不遵循它**；自定义数据目录时，显式传入实际 profile：

```powershell
powershell -NoProfile -File ./scripts/check-desktop-install.ps1 `
  -AppPath '实际 DSH 安装目录' `
  -ProfilePath '实际 DSH 数据目录\profiles\desktop'
```

检查脚本核对安装文件及捆绑 CLI 与构建目标版本；运行中的页面还需执行 `__DSH_MESSAGE_EDIT__.diagnostics()`，确认前后端构建身份匹配。诊断字段 `matched` 只证明客户端与宿主构建一致，功能仍需实际操作。

## 桌面回归按项目规则执行

将 `CLAUDE.md` 的“必须保持的行为”转换成本次操作清单，覆盖保存与保存并发送的区别、重开会话后的持久化、附件/引用、助手编辑与版本、输入法/快捷键、会话切换与明暗主题。检查显示、数据与模型调用行为，不只确认按钮能点击。

使用独立测试会话；涉及请求模型、分支或会话修改时按实际授权进行。首次打开需等待历史加载是现有已接受限制，不默认纳入本次优化。

目标桌面无法操作时，向维护者交付实际待验收步骤和预期结果，收到反馈后补齐记录。项目进度和已验证范围写入 `log/README.md` 与当天日志；发版另按 `docs/发布指南.md` 执行。
