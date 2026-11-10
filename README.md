# codebuddy-cli

把本机的腾讯 CodeBuddy CLI（`codebuddy`）接成 Magpie 里的一个模型 provider。装好以后，
OpenCode、Claude Code 等客户端经由 Magpie 调用 CodeBuddy 向本插件开放的模型，请求实际由
`codebuddy` 进程完成。

## 这是什么

插件以 Magpie provider 的形式运行。客户端发来 Anthropic Messages 格式的请求，插件把它
翻译成 ACP（Agent Client Protocol）消息，交给本机的 `codebuddy --acp` 进程处理，再把输出
翻译回流式响应。

- 底层是真正的 CodeBuddy CLI，走它自带的 ACP 通道。ACP 握手里的 `clientInfo` 是本插件
  自己的包名，不冒充其它编辑器；插件也不直接请求 CodeBuddy 的内部接口。
- 客户端自己的工具（读写文件、执行命令等）通过 MCP 暴露给模型。工具由客户端执行，结果
  回传到同一轮 CodeBuddy 对话里，模型看到的是原生工具调用。
- 账号由 CodeBuddy CLI 自己管理。插件读取 CLI 已有的登录，不保存、不刷新、不转存凭据。

## 与 WorkBuddy 插件的区别

社区里的 WorkBuddy 插件（`opencode-workbuddy-auth`）走的是 CodeBuddy 的后端 API：插件自己
拼请求、自己带 token。本插件走的是另一条路：

- **运行的程序**：本插件运行你自己装好、自己登录过的 `codebuddy` CLI，用它的 ACP 通道。
  不解析、不逆向任何后端接口。
- **会话**：插件维护一个 ACP 进程池，同一段对话复用同一个 CodeBuddy 会话；会话数超出上限
  时回收最久未用的那个，回来的对话用历史重新开头。
- **工具调用**：客户端的工具以 MCP 服务的形式交给 CodeBuddy。模型调用时，插件把这次调用
  作为 `tool_use` 结束当前响应，客户端执行后回传结果，CodeBuddy 在同一轮里继续（见下文
  「工具桥接」）。
- **模型列表**：以 CodeBuddy 在 ACP 会话里给出的为准，包括账户自己的上下文窗口、是否支持
  图片与思考等级。插件不内置模型清单。

## 功能

- **CodeBuddy 开放的模型**：模型列表来自 ACP `session/new`，带每个模型的上下文窗口、
  图片支持与思考等级。列模型时插件开一个会话问一次（不发 prompt），问到之前先列出三个常见
  模型占位。
- **流式输出与思考**：CodeBuddy 的 thought chunk 以 `thinking` 块返回。请求里带
  `thinking: { "type": "disabled" }` 可关闭。
- **图片输入**：支持内联 base64 的 PNG、JPEG、GIF、WebP，需要 CodeBuddy 声明图片能力。
- **工具调用**：客户端声明的工具经 MCP 交给模型，支持并行与连续调用，每个调用只在客户端
  执行一次。
- **会话续接**：同一对话的多轮复用同一个 CodeBuddy 进程，CLI 自己保留上下文；客户端改写
  了历史时自动开新会话，不猜。
- **工具**：客户端的工具经 MCP 交给模型；CodeBuddy 自己的内置工具也允许，在插件宿主的工作
  目录运行，见「工具桥接」。`CODEBUDDY_BRIDGE_NATIVE_TOOLS=0` 可关掉内置工具。
- **不读全局 MCP 配置**：每次会话只带插件自己的 MCP 服务，`--strict-mcp-config` 未强制，
  但会话里不传其它 server。

## 环境要求

- CodeBuddy CLI（`codebuddy`），支持 `--acp --acp-transport stdio`。本项目在 **2.181.0** 上
  核验协议行为。
- Node.js 22 或更新。
- 支持 OpenCode 风格 provider 插件的 Magpie。

### 安装 CodeBuddy CLI

```sh
npm install -g @tencent-ai/codebuddy-code
```

运行 Magpie 的用户必须能找到 CLI。桌面应用 PATH 尚未更新时可显式设置 `CODEBUDDY_PATH`
指向 CLI 入口。

账号由插件在 Magpie 里登录，不需要先在终端登录 CLI。没有添加任何账号时，插件使用 CLI 自己
的登录作为默认账号。

## 安装

```sh
magpie plugin add @magpie-community/opencode-codebuddy-cli-auth
```

装好后 provider id 是 `codebuddy-cli`，模型写成 `codebuddy-cli/<模型>`。默认并发 8，可在
Magpie 的 Providers 页 Concurrency 里改。

## 使用

1. 在 Magpie 的 Providers 页找到 `codebuddy-cli`，点 Sign in。插件打开 CodeBuddy 自己的登录页，
   授权完成后这个账号就加进来了。**再点一次可以加第二个账号**，以此类推。
2. 模型名写成 `codebuddy-cli/<模型>`，模型 ID 与 CodeBuddy 给出的一致（例如
   `codebuddy-cli/hy3`）。
3. 在客户端里选用这个模型即可。

登录页也可以直接粘贴 access token，用于浏览器流程到不了的环境（企业部署、无桌面的机器）。

## 多账号与路由

每个账号是 CodeBuddy 的一次登录。Magpie 把每个账号单独保存（`plugin-auth.json` 里的
`codebuddy-cli#xxxx`），并负责在它们之间路由：

| 路由 | 行为 |
|---|---|
| `smart` | 按用量与余量挑 |
| `order` | 按列表顺序用，前面的满了再往后 |
| `rotate` | 轮流 |
| `usage` / `pace` / `weight` | 按用量、节奏、权重 |

这些是 Magpie 内置的，插件不参与挑选。插件要做的是三件事：

- **每个请求用被选中账号的 token。** Magpie 把请求限定到某个账号，插件从 `loader` 的
  `getAuth()` 读该账号的凭据，作为 `CODEBUDDY_AUTH_TOKEN` 交给这个请求的 CodeBuddy 进程。
- **不同账号不共用进程。** 一段对话在账号 A 上跑过后，路由到账号 B 的同一段对话会另开进程，
  不会拿 A 的身份回答。账号是会话键的一部分。
- **模型列表按账号取。** Magpie 用该账号的凭据问一次模型，所以列出来的是这个账号真能用的。

账号的身份（`sub` / 昵称 / 邮箱 / 过期时间）从 token 自己的声明里读，所以同名账号也能区分开。
token 过期后该账号的请求会返回 401，重新登录该账号即可。

想在几个模型之间路由时，用 Magpie 的路由组：

```sh
magpie group add cbtest models=codebuddy-cli/hy3 routing=rotate
```

客户端选用 `group/cbtest` 即可。上面的 `smart`、`order`、`rotate`、`usage`、`pace`
都已在本机两个账号上实测，各自连续 6 次请求全部成功。

## 账号余额

在 Magpie 的 CodeBuddy 账号用量中刷新，可分别查看每个已授权账号的剩余积分和总额度。
命令行也可查询：

```sh
magpie quota codebuddy-cli
magpie quota codebuddy-cli --json
```

查询使用该账号自身的授权，只读调用 CodeBuddy 中国区积分资源接口，不启动 CLI，也不消耗模型点数。
有效套餐和赠送包按官方精确字段汇总，过期或尚未生效的资源不计入余额；界面显示两位小数，
底层保留接口精度。查询失败、分页不完整或授权失效时显示错误，不会显示成零余额，也不会改用其他账号。

余额以刷新时的读数为准，由 Magpie 管理刷新和展示；使用量路由可以读取对应的积分窗口。

## 工具桥接

客户端的工具经 MCP 交给 CodeBuddy，工具名形如 `mcp__client-tools__<工具名>`。CodeBuddy 通过
自己的 `DeferExecuteTool` 转一次，需要一次权限授予，插件对这类调用一律允许。

CodeBuddy 自己的内置工具（Bash、Read、Edit、Write 等）**默认也允许**：它们在这个插件启动
CLI 的工作目录里运行，即插件宿主的工作目录，不保证是客户端的项目目录。CodeBuddy
把"内置工具被拒"当成整轮取消，模型也就没法继续。要强制所有操作都走客户端工具，设
`CODEBUDDY_BRIDGE_NATIVE_TOOLS=0`。

工具调用慢于 CodeBuddy 的 MCP 超时（约 150 秒）时，插件先回一句 "still running"，客户端
结果到达后再作为新的一条提示词送到同一会话，模型仍能看到结果。

## 并发

- 插件自己的进程池上限由 `CODEBUDDY_BRIDGE_MAX_PROCS` 决定，默认 8 个进程。
- Magpie 的 Providers 页有单独的 Concurrency 设置。两处数值建议保持一致。
- 进程池满且没有空闲进程可回收时，插件返回 HTTP 503。

一个 CodeBuddy 进程一次只跑一轮对话。同一段对话同时来了两个请求时，后到的请求排队，
不会清空或打断前一请求的流。前一响应完成后重新校验历史：历史一致时复用进程；改写了用户
或助手消息、缺少前一回复、补入尚未处理的历史时，启动新进程并重放历史。
等待超过 `CODEBUDDY_BRIDGE_QUEUE_MS`（默认 300000 毫秒）返回 HTTP 503。

账号、模型、推理档位、工具名称及 schema、原生工具权限配置均参与进程复用签名。改变这些
配置时不复用旧进程或备用进程。备用进程和启动中的进程也计入总进程上限。

## 响应速度

CodeBuddy 进程启动和 ACP 握手需要时间。历史一致的后续轮复用现有进程；新对话可以接管
复用签名匹配的备用进程，否则需要冷启动。实际首个内容的耗时还取决于模型与服务端负载。

进程池有空余容量时，在后台保留至多一个备用进程。账号、模型、推理档位或工具集不同，
备用进程会被停止后重新创建。备用进程同样受 `CODEBUDDY_BRIDGE_IDLE_MS` 管理。
Magpie 的 Concurrency 控制请求并发，进程总数由 `CODEBUDDY_BRIDGE_MAX_PROCS` 单独控制。

### 思考过程

CodeBuddy 的思考内容怎么发出去，取决于客户端有没有要：

- **请求里带 `thinking: { "type": "enabled" }`**：以 `thinking` 块发送，客户端显示为思考过程。
- **没带**：思考内容并入正文发送。

第二条是为了解决一个实际问题：Magpie 网关只在客户端自己要了 thinking 时才转发 `thinking`
块，否则直接丢掉。客户端没要的时候如果仍按 thinking 块发，用户在模型思考的那十几秒里
什么都看不到——实测首个内容要等 16 秒。并进正文后同样一次请求 2.5 秒就开始出内容。

`thinking: { "type": "disabled" }` 关掉思考内容，只有最终回答。

### 推理强度

插件优先读取明确的档位：Anthropic 的 `output_config.effort`，以及兼容接口的
`reasoning_effort` / `reasoning.effort`。只有没有明确档位时，才按 Magpie 相同的规则
将 `thinking.budget_tokens` 换算为档位。最终档位通过 `--effort` 传给 CodeBuddy；
备用进程只在账号、模型、档位、工具集及权限配置均一致时复用。

插件模型目录不再默认声明 8192 的推理模型输出上限，未提供上限时使用 32768 作为接口预算。
Magpie 会将其同步给 DSH，使 high 的 16384 思考预算得以保留，不再被截成 7168 后误判为 medium。
这不是 CodeBuddy 的生成长度保证，实际生成由 CLI 控制。

自定义 Anthropic 客户端也可使用 `thinking: {type: "adaptive"}` 加
`output_config: {effort: "high"}` 直接指定档位，无需从预算反推。
DSH 的对应兼容选项是 `compat.forceAdaptiveThinking: true`；Magpie 管理的模型配置会被自动重写，
不应依赖直接修改生成配置。预算模式无法区分使用同一预算的 xhigh/max，直接指定档位可避免这种歧义。

## 平台

- **macOS、Linux**：支持。
- **原生 Windows**：支持。npm 装的 `codebuddy.cmd` 不能直接 spawn，插件读这个 shim 找到
  真正的 Node 入口，用当前 Node 进程启动它，全程不经过 `cmd.exe`。

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CODEBUDDY_PATH` / `CODEBUDDY_BIN` | 按 PATH 查找 | 指定 CLI 入口；给了就只用它，不可用时报错而不是换一个 |
| `CODEBUDDY_BRIDGE_MAX_PROCS` | 8 | CodeBuddy 进程池上限 |
| `CODEBUDDY_BRIDGE_IDLE_MS` | 600000 | 进程空闲多久后回收 |
| `CODEBUDDY_BRIDGE_QUEUE_MS` | 300000 | 同一对话等待前一请求完成的最长时间，超时返回 503 |
| `CODEBUDDY_BRIDGE_FIRST_EVENT_MS` | 2500 | 流开始前等待首个事件，以便将立即失败转成 HTTP 错误；不是整轮超时 |
| `CODEBUDDY_BRIDGE_START_TIMEOUT_MS` | 90000 | 进程启动与 ACP 握手的超时 |
| `CODEBUDDY_BRIDGE_TURN_IDLE_MS` | 600000 | 一轮里多久没有任何输出就判定卡住 |
| `CODEBUDDY_BRIDGE_TOOL_DEADLINE_MS` | 150000 | 工具跑这么久还没结束时，先回 "still running" |
| `CODEBUDDY_BRIDGE_TOOL_TIMEOUT_MS` | 1800000 | 等待客户端工具结果的总时长 |
| `CODEBUDDY_BRIDGE_CATALOG_TTL_MS` | 300000 | 模型列表的缓存时长 |
| `CODEBUDDY_BRIDGE_NATIVE_TOOLS` | 开启 | 设为 `0` 禁止 CodeBuddy 自己的内置工具，只走客户端工具 |
| `CODEBUDDY_BRIDGE_SKIP_PERMISSIONS` | 关闭 | 设为 `1` 传 `--dangerously-skip-permissions`，仅用于可信任务 |
| `CODEBUDDY_AUTH_TOKEN` | 未设置 | 没添加账号时使用的 token；添加了账号就用账号的 |
| `CODEBUDDY_AUTH_TOKEN_FILE` | 未设置 | 同上，从一个文件读，每轮重新读；接受裸 token，或含 `accessToken` / `auth.accessToken` 的 JSON |
| `CODEBUDDY_CLI_DISABLE_AUTO_UPDATE` | 插件设为 `true` | CodeBuddy 自己的变量；你设了就用你的值 |

账号优先。在 Magpie 里添加过账号后，请求用被路由到的那个账号的 token；这两个变量只在没有
任何账号时生效（这时用 CLI 自己的登录，或你给的 token）。

`CODEBUDDY_AUTH_TOKEN_FILE` 是给长期运行的 Magpie 用的：环境变量只会进入它之后启动的进程，
桌面版已经在跑时改不了。token 文件每轮重新读，续期后不用重启。

## 常见排查

- **找不到 codebuddy**：设置 `CODEBUDDY_PATH` 指向 CLI 入口，或确认 `codebuddy` 在 PATH 里。
- **HTTP 401，提示 CodeBuddy 拒绝了账户**：在终端运行 `codebuddy`，用 `/login` 重新登录，
  再点一次 Sign in。插件不刷新 token。
- **模型直接回答而没有调用工具**：确认客户端的工具确实随请求发了；CodeBuddy 会把它们当作
  延迟工具，第一次调用需要一次权限授予，插件已经自动允许本插件 MCP 服务里的工具。
- **HTTP 503**：进程池满。提高 `CODEBUDDY_BRIDGE_MAX_PROCS` 和 Providers 页的 Concurrency。
- **HTTP 409**：客户端回传的工具结果与当前 CodeBuddy 轮次对不上（通常是对话中途改写了历史
  或工具 ID）。插件不做猜测，请从最后一条自洽的消息重发。
- **想关掉思考**：设置请求里的 `thinking: { "type": "disabled" }`。

## 开发

```sh
node --test test/*.test.mjs
```

测试用假的 CodeBuddy 进程（`test/fake-acp.mjs`，一个 ACP stdio 服务）跑完整的 ACP 与 MCP
链路，不消耗模型额度。平台测试在已安装 CLI 时还会执行 `--version`，不发起模型推理。

## License

MIT。见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。
