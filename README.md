# omp-acp-provider

将实现 ACP stable v1 stdio 协议的程序注册为 OMP provider/model。每个 ACP 配置分别注册一个 provider，可在 `/model` 中选择。

## 快速开始

将仓库推送至 GitHub 后，可直接安装（需要 `git`）：

```sh
omp plugin install github:OhYee/omp-acp-provider
```

更新已安装的 Git 插件：

```sh
omp plugin upgrade omp-acp-provider
```

本地开发时，可在插件目录安装依赖并链接到 OMP：

```sh
npm ci
omp plugin link "$(pwd)"
```

创建 `~/.omp/agent/acp-provider.json`：

```json
{
  "auto": {
    "codebuddy": true,
    "opencode": true
  }
}
```

`auto` 中将表内对应键设为 `true` 即启用该预设，可同时启用多个；未列出的 Agent 仍通过 `agents` 自定义。插件直接启动表中命令，不调用 `npx`，因此不会隐式下载或运行另一份 CLI。除 `claude` 和 `codex` 使用独立 ACP adapter 外，其余命令需已安装在 OMP 进程的 `PATH` 中。

| `auto` 键 | 本地命令与参数 |
|---|---|
| `auggie` | `auggie --acp` |
| `bob` | `bob acp` |
| `claude` | `claude-agent-acp` |
| `cline` | `cline --acp` |
| `codebuddy` | `codebuddy --acp` |
| `codex` | `codex-acp` |
| `copilot` | `copilot --acp` |
| `cursor` | `cursor-agent acp` |
| `gemini` | `gemini --acp` |
| `goose` | `goose acp` |
| `kimi` | `kimi acp` |
| `kiro` | `kiro-cli acp --agent-engine=v3` |
| `minimax` | `mcode acp` |
| `mistral` | `vibe-acp` |
| `opencode` | `opencode acp` |
| `qwen` | `qwen --acp --experimental-skills` |

Claude Code 与 Codex 的 ACP adapter 需单独安装到 `PATH`，例如：

```sh
npm install -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp
```

这些预设按 [ACP 官方 Registry](https://agentclientprotocol.com/get-started/registry) 与各项目 CLI 文档整理；并非 Registry 的全部条目。registry 列表持续变化，任意其他支持 ACP 的程序仍可通过 `agents` 自定义配置。

重启 OMP 后运行 `/model`，选择对应 `acp-<id>` provider 下的模型。ACP Agent 公布的模型选项会被发现并列出；否则显示该 Agent 的默认模型。修改配置后需重启 OMP。

OMP 会持久化模型目录；插件或客户端本机模型元数据更新后若仍显示旧值，运行 `omp models refresh` 强制重新发现模型，再打开 `/model`。


## 配置项

| 配置 | 默认 | 说明 |
|---|---:|---|
| `id` | 必填 | 唯一 provider ID，只允许字母、数字、`_`、`-` |
| `name` | `id` | 模型列表显示名 |
| `command` | 必填 | ACP 可执行程序 |
| `args` | `[]` | 命令参数数组；自定义配置替换预设基础参数。CodeBuddy 的运行时默认参数见下文。 |
| `env` | `{}` | 子进程环境覆盖 |
| `contextWindow` | `128000` | OMP 的模型上下文窗口元数据 |
| `maxTokens` | `16384` | OMP 最大输出 token 元数据；ACP 未提供通用方式强制此上限 |
| `metadataProvider` | 无 | 用于查找 OMP 模型目录元数据的 provider ID；部分自动预设按对应模型命名空间设置 |
| `modelOverrides` | `{}` | 按 ACP 模型选项 ID 指定模型级 `contextWindow`、`maxTokens` 和 `cost` |

`command` 与 `args` 以无 shell 方式启动。ACP 子进程继承 OMP 环境变量，`env` 可覆盖变量。`agents` 可配置多个 ACP，各自使用独立的 `id`、命令和选项。

CodeBuddy 自动预设的基础参数是 `codebuddy --acp`。启动时：

- `args` 未包含 `--tools`、`--allowedTools` 或 `--disallowedTools` 时，插件追加 `--tools ""`。本机 `codebuddy --help` 说明该参数用于限制内建工具。
- 未显式指定 `--system-prompt` 或 `--system-prompt-file` 时，插件将 OMP system prompt 和工具策略写入权限为 `0600` 的临时文件，并通过 `--system-prompt-file` 传入；子进程退出后删除。
- OMP 工具通过 ACP `session/new` 的 MCP server 单独传入。

自定义 `args` 中显式指定 `--tools`、`--allowedTools` 或 `--disallowedTools` 时，插件不再追加 `--tools ""`；显式指定 system prompt 参数时，插件不注入 OMP prompt file。自定义参数仍需保留 ACP 启动参数。
如果 Agent 发起 ACP 权限请求，插件会自动选择 `allow_once`，不会弹出 OMP 审批框。


只运行可信的 ACP 程序：子进程会继承 OMP 环境中的凭据，系统提示和对话历史会发送给该程序及其后端。出错时，客户端 stderr 的末尾也可能出现在 OMP 错误记录中；分享日志前请检查敏感信息。不要将包含凭据的本地配置提交到仓库。

## 能力与边界

- ACP 没有通用参数可隐藏 Agent 自带工具。CodeBuddy CLI 的 `--tools` 用于限制内建工具；插件在未显式设置 `--tools`、`--allowedTools` 或 `--disallowedTools` 时传入空值。OMP 工具通过 ACP `session/new` 单独传入。
- 对其他 ACP，插件不追加未经验证的客户端专用参数，因此其自带工具仍可能可用。Agent 发起 ACP 权限请求时，插件优先选择 `allow_once`；没有该选项则返回 `cancelled`，不会弹出 OMP 审批框。
- OpenCode 的 `permissions` 用于执行授权；文档未承诺它能从模型请求中隐藏工具，因此插件不将它用作工具过滤开关。
- OMP 的 `context.tools` 会通过 ACP `session/new` 的 `mcpServers` 暴露给 Agent：优先使用 Agent 声明支持的 Streamable HTTP MCP，否则使用 stdio MCP。Agent 调用该 MCP 工具后，插件将请求转换为 OMP 原生 `toolCall`，由 OMP 执行；工具结果在 OMP 后续轮次中返回给 Agent。只有 OMP 当前轮次实际提供的工具可被调用；Agent 必须支持并实际调用 MCP，单靠提示词不能把文本伪工具调用变成执行。
- 自动批准不是沙箱。Agent 仍可能使用客户端未禁用、且不需要 ACP 权限请求的工具；MCP 或插件工具也可能仍可用。CodeBuddy 在未显式配置工具策略参数时传入 `--tools ""`，其他 ACP 仍可能保留原生工具。只运行可信 ACP 程序，并使用客户端或操作系统提供的隔离能力。
- ACP 没有通用 system prompt 字段。CodeBuddy CLI 提供 `--system-prompt-file`，插件会尝试通过它传入 OMP system prompt；其他 Agent 则收到把 OMP 系统指令与对话历史合并后的 ACP user prompt。
- 验证限制：本机真实 CodeBuddy ACP smoke 返回 `ACP agent refused the prompt`，未能端到端确认 system prompt 覆盖及禁用内建工具后的 OMP MCP 调用。另一次独立的 `codebuddy --print` 返回 HTTP 429；这与 ACP refusal 是分开的观察，原因尚未确认。
- ACP stable v1 的 `usage_update` 可报告当前上下文 token 数、窗口大小和可选的累计费用。Agent 发出该更新时，插件会记录实际窗口供后续模型刷新使用，并将报告的 USD/credits 费用写入本轮 usage；协议未提供输入/输出 token 费用拆分。
- `contextWindow` 与 `maxTokens` 是 OMP 模型元数据，不会强制 ACP 后端使用对应限制；ACP `usage_update` 提供的窗口大小是本次会话的运行时观测值，`maxTokens` 则从客户端本机模型元数据、OMP catalog 或手动配置获取。

模型列表由 ACP `session/new` 的 model 选项动态提供。自动预设中的 `metadataProvider` 只标识 OMP catalog 的 provider namespace，不保存模型窗口等静态值；自定义 Agent 也可显式配置它。优先级为：`contextWindow`：手动覆盖 > ACP `usage_update` 实测窗口 > 对应客户端本机模型元数据 > OMP catalog > 通用默认值；`maxTokens`：手动覆盖 > 客户端本机模型元数据 > OMP catalog > 通用默认值；费用：手动覆盖 > 客户端本机模型元数据 > OMP catalog > `0`（未知）。CodeBuddy/Kiro 等 credits 不是 USD/token，不会换算成 OMP 成本。

ACP `usage_update` 的累计费用是本轮实际会话费用，不是每 token 单价；Agent 未报告时无法仅从 ACP 协议推导实际费用。若未匹配到目录或手动价格，零值仅表示未知，不代表免费。

不按 CLI 名称给所有模型写同一个窗口值：同一 Agent 可切换不同模型、账号或代理后端。插件优先读取客户端公开的本机模型限制；没有可信来源时再按模型 ID/provider namespace 查询 OMP catalog，或使用手动 `modelOverrides`。官方 API 即使提供模型元数据，也可能要求与 CLI 不同的 API 凭证或只覆盖特定后端，例如 [Anthropic Models API](https://platform.claude.com/docs/en/api/models/list) 与 [Gemini Models API](https://ai.google.dev/api/models)；插件不会擅自读取 CLI 凭证。

## 客户端本机模型元数据

CodeBuddy 的窗口和输出上限从本机 Product Configuration 缓存读取：默认目录为 `~/.codebuddy/local_storage`，设置 `CODEBUDDY_CONFIG_DIR` 时改读该目录下的 `local_storage`。插件扫描哈希化的 `entry_*.info` 文件并选择最新有效快照，只提取模型 ID、`maxInputTokens`/`maxAllowedSize` 和 `maxOutputTokens`。**不再保留 CodeBuddy 静态模型限制**；缓存缺失或不含该模型时，回退到 OMP catalog、通用默认值或手动 `modelOverrides`。credits 不转换成 USD。

OpenCode 的模型目录来自其本机 models.dev 缓存：`$XDG_CACHE_HOME/opencode/models.json`，默认是 `~/.cache/opencode/models.json`。插件读取模型的 `limit.context`、`limit.output` 和 `cost` 字段，并叠加 OpenCode 配置中的 `providers.<provider>.models.<id>.limit`（支持 JSON/JSONC、`OPENCODE_CONFIG` 和 `OPENCODE_CONFIG_CONTENT`）。详见 [OpenCode 模型配置](https://opencode.ai/docs/models/) 与 [配置路径](https://opencode.ai/docs/config/)。

ACP 标准提供动态模型选项和可选的 `usage_update`，但没有统一的最大上下文/输出限制字段；`usage_update` 报告的是运行时用量，不等于模型能力声明。其他 ACP 继续通过 OMP catalog 的 provider namespace 映射或手动 `modelOverrides` 获取元数据；目前没有可通用读取的本机限制文件格式。


## 验证

```sh
bun test
bun run typecheck
```
