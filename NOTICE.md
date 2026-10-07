# 来源与许可声明

本分支基于 Moeblack 的 `dsh-message-edit` 项目：

- 上游地址：https://github.com/Moeblack/dsh-message-edit
- 基础版本：`0.2.3`
- 基础提交：`b78a167064ca612f1c400060d2bfc1dc9bc46436`
- 上游 `package.json` 声明的许可证：`MIT`

本项目现以 **dsh-plugin-message-edit** 独立维护，新增 DSH 桌面端 `0.2.0-rc.2` 的接口适配、原地保存、完整附件编辑、Windows 构建支持及自动化测试。保留上游原始作者信息；本项目不将原作者代码声明为新维护者原创。

桌面端适配由 [shirobana](https://github.com/sh1robana) 与 Codex（OpenAI AI 编程助手）协作完成，Codex 参与兼容代码、测试、安装脚本和文档的编写。贡献记录见 README。

上游仓库在上述提交中未附完整 `LICENSE` 文件，但 `package.json` 明确声明 `MIT`，Git 历史确认原作者为 Moeblack。本分支据此补充标准 MIT 文本，保留 Moeblack 的版权归属，不虚构其版权年份；这份文本由本分支补足，并非声称上游已经提供该文件。完整条款见 `LICENSE`。

`scripts/dsh-client-preset.ts` 保留了来自 DeepSeek Harness 的构建预设来源。其 MIT 许可文本和 `Copyright (c) 2026 DeepSeek` 声明已与本地官方 `@deepseek-ai/dsh-session@0.2.0-rc.2/LICENSE` 核对，并保留在 `LICENSE` 中。新增修改同样以 MIT 发布。

无修改保存、输入法候选确认保护、构建诊断及修订互通接口的设计参考了 [DDDMUC/dsh-edit-turn@0.2.20](https://github.com/DDDMUC/dsh-edit-turn)，本次没有复制其实现代码。

感谢 [dsh-market](https://github.com/dsh-market/dsh-market)、[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的市场与贡献说明，以及 [dsh-find-plugin](https://github.com/awesome-dsh-plugin/dsh-find-plugin) 的 README 组织方式参考。README 的功能说明与使用步骤根据本项目实际实现重新撰写。

运行与构建使用官方 `@deepseek-ai/*`、React、Zustand、Immer、tsdown、TypeScript 和 Lightning CSS。依赖保留各自许可证；打包预设保留第三方许可注释。
