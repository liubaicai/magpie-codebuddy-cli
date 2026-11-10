# NOTICE：来源与合规说明

本包（`@magpie-community/opencode-codebuddy-cli-auth`，版本 0.1.3）是一个独立的 Magpie /
OpenCode provider 插件，把本机的腾讯 CodeBuddy CLI 接入 Magpie。**与腾讯、CodeBuddy、
WorkBuddy 官方均无隶属关系，也未获其认可。**

## 1. 包与标识

| 项目 | 取值 |
|---|---|
| npm 包名 | `@magpie-community/opencode-codebuddy-cli-auth` |
| 版本 | `0.1.3` |
| 仓库 | `https://github.com/magpie-community/plugins`（`packages/codebuddy-cli`） |
| Magpie provider ID | `codebuddy-cli` |
| 安装 | `magpie plugin add @magpie-community/opencode-codebuddy-cli-auth` |

## 2. 来源基线

本包按 [magpie-community/plugins](https://github.com/magpie-community/plugins) 的包结构
编写，参考了同仓 `packages/agy-cli`（另一条「把本机 CLI 经 ACP 接成 provider」的路线）的
插件形态、`auth` / `provider` 钩子的组织方式，以及 `scripts/opencode2.mjs` 适配器。

**代码为独立实现。** 本包不包含 `agy-cli` 的源码，也不复制其实现：

- `agy-cli` 通过一个私有 `nc` 拦截 agy 的 IDE 拨号来实现工具桥接；本包使用 CodeBuddy ACP
  原生支持的 HTTP MCP 服务（`session/new` 的 `mcpServers`），不需要替换任何外部命令。
- `agy-cli` 的会话续接使用 `session/resume` 与状态文件；本包用进程池内的活会话复用，配合
  历史哈希判断是否可以接上。
- 模型目录、usage、错误映射、思考签名、历史渲染、权限策略均为针对 CodeBuddy ACP 的独立
  实现。

`opencode2.mjs` 是仓库范围内逐字节共享的适配器（`scripts/opencode2.mjs` 为唯一编辑副本，
`scripts/check.mjs` 校验各包副本一致），因此本包携带的是同一份字节，不是 `agy-cli` 的代码。

上游 `agy-cli` 的版权声明见其 `packages/agy-cli/LICENSE`。本包新增部分以 MIT 协议发布，
版权归 magpie-community/plugins 贡献者。

## 3. 与 CodeBuddy 的关系

- 插件**运行你自己安装、自己登录的 `codebuddy` CLI**，使用它公开的
  `--acp --acp-transport stdio` 通道。不下载任何腾讯服务端，不逆向、不直连 CodeBuddy 的
  内部模型接口。
- 插件接收用户显式授权的账号 token：包括登录流程交给 Magpie 的凭据、Magpie 按账号提供的
  凭据，以及 `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_AUTH_TOKEN_FILE`。添加到 Magpie 的账号由
  Magpie 按账号保存；插件不另外把 token 写入磁盘，不刷新 token，推理时随请求注入 CLI。
- 登录授权和积分查询会调用 CodeBuddy 的账号、计费 HTTP 接口；模型生成仍通过 CLI 的 ACP
  通道完成。积分查询使用对应账号的授权，不消耗模型额度。
- 插件不提取桌面凭据、不解密系统凭据库、不改动官方客户端文件。
- 订阅额度由 CodeBuddy 计费，插件不代为估算或规避。

## 4. 使用须知

- CodeBuddy 的服务条款与账号政策由腾讯制定并可能变化。通过本插件使用 CLI 的后果由使用者
  自行承担，插件无法保证账号不受限制。
- 插件的工具桥接依赖 CodeBuddy ACP 的以下行为：`session/new` 接受 HTTP `mcpServers`、
  模型经 `DeferExecuteTool` 调用 MCP 工具、`session/request_permission` 询问授权。这些是
  实测于 **2.181.0** 的行为，不是 CodeBuddy 公开承诺的稳定接口，升级后可能变化。
- CodeBuddy 自己的内置工具（Bash、Edit、Write 等）默认允许，在插件宿主的工作目录运行，
  该目录不保证是远端客户端的项目目录。`CODEBUDDY_BRIDGE_NATIVE_TOOLS=0` 可禁止内置工具，
  仅通过客户端 MCP 工具执行操作。

## 5. 未包含的内容

本仓库不包含 CodeBuddy 本体、其 SDK、任何腾讯商标素材，也不包含真实的账户凭据。测试使用
`test/fake-acp.mjs` 模拟的 ACP 服务覆盖推理与工具链路，不消耗模型额度。平台测试在 CLI 已
安装时还会执行一次 `--version`，不发起模型推理。
