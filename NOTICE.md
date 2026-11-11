# 来源与第三方说明

本项目由 [liubaicai/magpie-codebuddy-cli](https://github.com/liubaicai/magpie-codebuddy-cli) 维护，是独立的 Magpie / OpenCode Provider 插件，与腾讯、CodeBuddy、WorkBuddy 官方均无隶属关系，也未获其认可。

## 项目标识与安装

| 项目 | 取值 |
|---|---|
| 展示名 | Codebuddy CLI |
| 包内兼容标识 | `@magpie-community/opencode-codebuddy-cli-auth` |
| Magpie Provider ID | `codebuddy-cli` |
| 源码与发布 | https://github.com/liubaicai/magpie-codebuddy-cli |
| GitHub 安装源 | `github:liubaicai/magpie-codebuddy-cli` |
| 版本 | 以 `package.json` 和对应 GitHub Release 标签为准 |

保留包内标识不表示已在该 npm 命名空间发布，也不表示本项目属于 magpie-community 组织。固定版本安装方法见 [README.md](README.md)。

## 代码来源与授权

本项目参考 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的插件包结构、Provider 钩子及 `packages/agy-cli` 的本地 CLI 接入形态。CodeBuddy 的工具桥接使用 ACP 会话提供的 HTTP MCP 服务，不需要替换 `nc` 或其他外部命令。

`opencode2.mjs` 来自上游 [scripts/opencode2.mjs](https://github.com/magpie-community/plugins/blob/main/scripts/opencode2.mjs)，以 MIT License 提供。上游在其单仓库中维护共享副本；本独立仓库保留该适配器快照，没有携带上游的共享副本检查脚本。原版权声明：

```text
Copyright (c) 2026 magpie-community contributors
```

该声明与 MIT 授权正文保留在本项目 [LICENSE](LICENSE) 中。本项目新增代码同样以 MIT License 发布。

## 产品名称与 Logo

CodeBuddy、WorkBuddy、腾讯及相关产品名称、商标与图像权利归各自权利人。

`assets/workbuddy.webp` 是使用者提供的 WorkBuddy 图像，用作本插件的识别图标。它不是本项目原创商标，不因软件采用 MIT License 而主张相关商标或图像权利，也不表示官方合作或认可。

## 账号、推理与工具边界

- 模型推理通过用户自行安装的 `codebuddy --acp --acp-transport stdio` 完成；插件不绕过 CLI 直接调用内部模型接口。
- 浏览器授权和积分查询会调用 CodeBuddy 的账号、计费 HTTP 接口。积分查询使用对应账号的授权，不发起模型推理。
- Magpie 保存各账号凭据，插件按请求所选账号注入 CLI，不另外把 token 写入磁盘，也不实现 token 刷新。
- 未提供账号回调的调用方可显式配置默认 token、token 文件，或使用 CLI 自身登录。已提供账号回调时，授权读取失败不会回退到机器身份。
- 插件不提取桌面凭据、不解密系统凭据库、不修改官方客户端文件。仓库和发布包不包含真实账户凭据、CodeBuddy 本体或其 SDK。
- CodeBuddy 原生工具默认允许，在 Magpie 宿主工作目录运行；该目录不保证是客户端项目目录。客户端工具则经本插件的 MCP 服务转交客户端执行。
- CLI 如何加载自身配置和其他 MCP 服务由 CLI 决定。本插件未强制严格 MCP 配置隔离。

## 兼容性

协议核验基线为 CodeBuddy CLI 2.181.0，包括 ACP 会话元数据、HTTP MCP、工具授权和思考分片行为。CLI、账号服务、订阅权限和服务条款可能更新，插件不保证未来版本的行为与该基线完全相同。

默认协议回归使用假的 ACP/MCP 进程，不消耗模型额度。可选 CLI 版本检查只执行 `--version`；显式的真实模型诊断会消耗账号额度，详见 README。
