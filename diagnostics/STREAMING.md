# Magpie CodeBuddy 流式思考诊断

调查日期：2026-11-10，时间为 Asia/Shanghai。插件 0.1.3，Magpie 0.1.3492。

## 结论

插件在收到 CodeBuddy ACP `agent_thought_chunk` 后立即发送 Anthropic `thinking_delta`；DSH 也不等待思考签名或整轮结束才显示。已观察到的长时间等待发生在 Magpie 收到思考与向 DSH 交付思考之间。

Magpie 的拒答重试缓冲会对部分尚未获得信任的 DeepSeek 候选保留思考，以便在随后拒答时换到其他候选。它不是固定 120 秒超时；可能一直等到正文、缓存超过 1 MiB 或达到 4 分钟。最后一个候选直接放行思考；连续三次成功的 provider/model 也会获得即时流式的信任，拒答会重置信任计数。计数保存在内存，不能依赖一次短任务通过就认定每次启动都不会缓存。

## 真实请求记录

21:51:14 的 `codebuddy-cli/deepseek-v4.1-flash` 请求使用 high 档位，输入 39,378 tokens，请求工具清单为 113 项、约 112 KB。只提取时间、数量和长度，未在本报告保存消息、思考正文或凭据。

| 位置 | 首个思考 | 首个正文 |
|---|---:|---:|
| Magpie 接收计时（缓冲前） | 7.448 秒 | 279.477 秒 |
| DSH 收到的流记录 | 约 93.37 秒 | 约 279.55 秒 |

Magpie 首个思考对应 21:51:22.386，DSH 首个非空思考为 21:52:48.253，两者相差约 85.9 秒。正文到达时两端已经相近。这说明连接在传输，但思考一开始没有立即交付给 DSH。早于正文释放的大段思考与网关的缓存大小阈值相符；历史日志未记录当时缓冲器的精确大小、候选列表与信任计数，因此不把具体释放触发条件当作已测得的值。

`工具已更新 / 移除 21 个` 来自 DSH 对前后两次工具声明清单的差异记录。它不是 CodeBuddy 更新程序的输出，也不表示正在重连 21 个 MCP 服务。

`reasoning_hidden: true` 在这次记录中表示独立思考 token 数未知，不是关闭实时思考的配置。`first_reasoning_ms` 在 Magpie 的输出缓冲前计时，不代表用户已经看到了思考。

## 对照实测

使用同一个小计算任务与 DeepSeek high。ACP 和插件采用同一配置账号；网关按其现有策略选择账号。服务端生成有波动，以下数据用于判断是否逐片传输，不用于推导固定性能差或归因账号差异。

| 路径 | 首个 ACP 思考 | 首个 SSE 思考 | 整轮结束 |
|---|---:|---:|---:|
| 直连 ACP | 6.207 秒 | 不适用 | 16.067 秒 |
| 插件直连 | 8.002 秒 | 8.009 秒 | 21.776 秒 |
| Magpie 网关 | 未在同进程采集 | 7.925 秒 | 25.522 秒 |

插件的 2,616 个思考片段在整轮结束之前持续交付；网关对照请求也收到 2,813 个流式思考片段。这里没有复现冷状态的缓冲，不能由此否定真实请求记录里的 85.9 秒额外等待。

## 处理边界

问题在 Magpie 核心的拒答缓冲，修改插件的 `flush`、首事件等待或签名生成不能关闭该核心策略。0.1.3492 的 `errors=pass` 只适用于普通 API-key provider，源码明确排除了插件 provider；即使适用，它也会同时关闭错误重试，不是独立的“实时思考”开关。

本次没有改动账号路由、禁用第二账号、增加自动付费预热，也没有替换 Magpie 的程序。完整修复应在 Magpie 核心提供独立的即时思考选项，或调整该 provider 的思考缓冲，同时保留账号选择和错误处理。需要即时使用时，DSH 已有的直连 `codebuddy` provider 可以绕开这一层网关，但不经过 Magpie 的多账号路由。

## 复用诊断工具

从仓库根目录运行，默认不记录正文或凭据：

```sh
# 会实际调用模型并产生少量用量；默认依次测三层，可只指定其中一层。
node diagnostics/stream-timing.mjs acp plugin gateway --model=deepseek-v4.1-flash --effort=high

# 只读已有 DSH v4 zstd 会话，输出时间、事件数量、长度，不调用模型。
# Node 需要具备 zstdDecompressSync；输入路径指向具体会话文件。
node diagnostics/session-timing.mjs <session.v4.jsonl.zstd>
```

## 源码依据

- [Magpie 输出缓冲前记录时间](https://github.com/yetone/magpie/blob/v0.1.3492/internal/gateway/fallback.go#L2702-L2770)
- [思考缓存阈值与信任规则](https://github.com/yetone/magpie/blob/v0.1.3492/internal/gateway/fallback.go#L2904-L3003)
- [放行思考的判定](https://github.com/yetone/magpie/blob/v0.1.3492/internal/gateway/fallback.go#L3035-L3118)
- [最后候选直接放行](https://github.com/yetone/magpie/blob/v0.1.3492/internal/gateway/gateway.go#L3520-L3571)
- [reasoning_hidden 的含义](https://github.com/yetone/magpie/blob/v0.1.3492/internal/gateway/ttft.go#L322-L341)
- [errors=pass 不适用于插件 provider](https://github.com/yetone/magpie/blob/v0.1.3492/internal/provider/pass_errors.go#L3-L14)
