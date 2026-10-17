# 项目协作规则

本文件供新对话、模型和维护者接手时阅读。执行当前任务的明确要求；不要把历史日志中的计划当作新的操作授权。

## 接手顺序

1. 阅读本文件、`log/README.md` 和最近一份日期日志，确认当前进度、已验证范围与未完成事项。
2. 阅读 `README.md` 了解用户功能，涉及发布时再读 `docs/发布指南.md`；涉及来源与许可时读 `NOTICE.md`。
3. 修改前执行 `git status --short --branch`，阅读相关实现与测试，保留已有未提交修改。记录过的外部状态需要时重新核实。

## 项目定位与表达

- 项目名：`dsh-plugin-message-edit`；npm 包：`@sh1robana/dsh-plugin-message-edit`。
- 项目仓库：<https://github.com/sh1robana/dsh-plugin-message-edit>。
- 当前正式版本与发布状态以 `package.json`、`CHANGELOG.md` 和进度记录为准。
- 回复、文档、注释和提交信息使用简体中文；代码标识符、命令与 API 名称保留原文。
- 先说明结论，再给出必要细节。优先简单、直接、易维护的修改，不做无关重构。
- 本项目基于 `Moeblack/dsh-message-edit` 继续开发，设计参考 `DDDMUC/dsh-edit-turn`。保留 `LICENSE`、`NOTICE.md` 中的来源、版权和许可；贡献署名使用 shirobana 与 Codex（OpenAI AI 编程助手）。

## 代码入口

| 文件或目录 | 职责 |
| --- | --- |
| `src/index.ts` | 宿主接口、原地保存、分支重生成、重试、版本及附件操作 |
| `src/shared.ts`、`src/saved-user-messages.ts` | 前后端协议、版本结构、已保存用户消息的识别与投影 |
| `src/client/index.ts`、`controller.ts`、`transport.ts` | 客户端注册、会话状态、刷新协调与宿主通信 |
| `src/client/InlineMessageEdit.tsx`、`UserMessageProjection.tsx` | 消息操作按钮、编辑弹窗与原地修改后的消息显示 |
| `src/client/MessageComposer.ts`、`RichMessageInput.ts`、`composerTools.ts` | 编辑输入框、引用、权限、模型与推理选择 |
| `src/client/AttachmentEditor.tsx`、`attachmentTools.ts`、`fileReferences.ts` | 附件增删、粘贴拖入、预览、文件引用与打开 |
| `src/client/MessageEditTimelineView.tsx`、`MessageEditHeader.tsx` | Timeline 与版本切换入口 |
| `scripts/`、`tests/` | 构建、桌面安装核验与自动化测试 |

表中未重复写目录的客户端文件均位于 `src/client/`。

## 必须保持的行为

- **用户消息「保存」**：在原会话保存正文和完整附件，保留已有回复及后续对话，不创建新会话，不调用模型。不要复用会触发重新发送的原生编辑流程。
- **用户消息「保存并发送」**：携带修改后的内容及所选设置创建分支重新请求模型，原会话仍可切回。助手消息编辑与版本切换的既有行为也须保持。
- 保存或分支修改需要同时考虑持久化事件、模型上下文和用户消息投影，不能只替换页面文字。改协议时同步检查 `shared.ts`、宿主解析、客户端解码和旧版本事件兼容。
- 保留无修改保存、取消二次确认、中文输入法组字保护；用户编辑框的 `Ctrl+S` 为仅保存，`Enter` 为保存并发送，`Shift+Enter` 为换行。
- 编辑框的「+」只负责添加文件，不恢复目标、计划、反馈等菜单。权限与模型菜单保持紧凑；保留附件粘贴、拖入、移除、图片放大和蓝色引用打开。
- 文件打开沿用受校验的宿主接口及系统默认程序；不要把文件路径拼接成 shell 命令。
- 会话切换后按钮应绑定正确的会话和事件序号；后台刷新不能无故禁用已有可用操作。首次加载仍受宿主历史加载影响，维护者已接受该限制，不作为默认待办继续优化。
- 当前实际验证的兼容范围为 DSH 桌面端 `0.2.0-rc.2`、`0.2.1-rc.1`。升级官方依赖时同步核对宿主接口、客户端注入、manifest 与测试；未验证的版本不能宣称兼容。

## 构建与验证

- 需要 Node.js 24 或以上；依赖缺失或锁文件变更后使用 `npm ci`。官方 `@deepseek-ai/*` 运行时依赖保持在 `peerDependencies`，避免给 profile 安装重复宿主。
- 修改源码和构建配置后运行 `npm run build`（包含类型检查），再运行 `npm test`。修复缺陷时补充能覆盖真实行为的测试；只改文档时核对内容和链接即可。
- 编辑 `src/` 和构建配置。根目录的 `index.mjs`、`client.js`、`client.js.map`、`build-info.json` 及 `src/build-info.ts` 是生成文件，由构建脚本更新，不直接修补。
- 界面改动应核对明暗主题、中文输入、附件、保存与保存并发送的区别。自动化测试、安装文件校验和实际桌面点击验收分别记录，不能相互替代。
- 桌面更新使用 `scripts/install-desktop.ps1` 先备份配置；安装后彻底退出并重启 DSH。`npm run check:installed` 校验安装文件，页面的 `__DSH_MESSAGE_EDIT__.diagnostics()` 核对实际加载构建。
- 保留用户配置、插件和会话；测试会产生模型请求、分支或会话修改时，使用独立测试会话，不对无关的真实对话执行试验。

## Git 与发布

- 创建工作分支时默认使用 `codex/` 前缀。提交或推送前检查 `git remote -v` 与目标分支，不覆盖他人的修改。
- 本工作区的 `origin` 指向 Moeblack 上游，`publish` 指向本项目。其他克隆的命名可能不同：以实际 URL 为准，不能盲目执行 `git push origin`。
- 安装、推送与公开发布按当前任务的授权范围执行；已有明确授权不重复询问。账号登录和 2FA 由账号持有人在官方页面完成，不收集密码、令牌、验证码或恢复码。
- 发版遵循 `docs/发布指南.md`，同步版本、更新记录、构建产物和安装说明。已发布版本不覆盖；仅改维护文档通常无需发布新的 npm 包。
- `npm pack` 的作用域包文件名与 Release 文件名不同，按发布指南复制后再上传，核对两份内容一致；打包前核对文件清单。
- 社区目录 PR 仅提交自己的 `data/plugins/sh1robana__dsh-plugin-message-edit.yml`；通过 CI、审核合并、市场同步是不同阶段，进度记录中分别说明。
- `.inspection/`、`.local-backups/`、`.dsh/`、`artifacts/`、账号凭据、个人会话与私人截图只保留本地，不进入源码仓库或公开安装包。`log/` 只写适合公开的项目记录。
- 一次性排查、预览脚本、缓存和解包副本在任务结束后清理；需要复用的目标检查输入集中放在 `.inspection/host-inputs/<版本>/`。正式回归测试不要按文件年龄或是否跟踪来删除。
- 清理前确认 profile 的本地 `file:` 依赖，保留其引用的安装包；会话恢复尚待验收时，保留原件备份、最终恢复副本、映射与回退说明，不把它们当临时缓存删除。

## 进度记录

- 每次完成有实质内容的工作，更新 `log/README.md` 的当前状态，并在 `log/YYYY-MM-DD.md` 追加记录；日期使用北京时间，同一天沿用一个文件。
- 日志写清需求、实际改动、验证结果、遗留事项与下一步，附相关文件、提交或 PR 链接。未执行的验证明确注明，不把计划记为完成。
- 保留历史记录，不覆盖旧结论来掩盖失败；后续更正另写一条。避免逐条记录工具调用、整段聊天、密钥或大段运行输出。
- `CHANGELOG.md` 记录发布给用户的版本变化；`log/` 记录开发进度与交接信息，两者不要混为一份。
