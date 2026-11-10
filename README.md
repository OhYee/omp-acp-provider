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
| `args` | `[]` | 命令参数数组 |
| `env` | `{}` | 子进程环境覆盖 |
| `contextWindow` | `128000` | OMP 的模型上下文窗口元数据 |
| `maxTokens` | `16384` | OMP 最大输出 token 元数据；ACP 未提供通用方式强制此上限 |
| `metadataProvider` | 无 | 用于查找 OMP 模型目录元数据的 provider ID；部分自动预设按对应模型命名空间设置 |
| `modelOverrides` | `{}` | 按 ACP 模型选项 ID 指定模型级 `contextWindow`、`maxTokens` 和 `cost` |
| `allowTools` | `false` | 是否自动响应 ACP 权限请求：`false` 拒绝，`true` 自动选择 `allow_once` |

`command` 与 `args` 以无 shell 方式启动；ACP 子进程继承 OMP 环境变量，可用 `env` 覆盖额外变量。可在 `agents` 数组中配置多个 ACP，各自使用独立的 `id`、命令和选项。

只运行可信的 ACP 程序：子进程会继承 OMP 环境中的凭据，系统提示和对话历史会发送给该程序及其后端。出错时，客户端 stderr 的末尾也可能出现在 OMP 错误记录中；分享日志前请检查敏感信息。不要将包含凭据的本地配置提交到仓库。

## 能力与边界

- 插件将 ACP Agent 当作完整 provider 调用。Agent 可使用自己的工具；OMP 工具不会转发给 ACP。
- `allowTools: false` 会拒绝 ACP 权限请求；`allowTools: true` 会自动批准请求中的单次权限，不会显示 OMP 审批对话框。此设置不是沙箱，Agent 仍可能执行不经 ACP 权限请求的内建工具；只对可信程序启用。
- 每次生成时，OMP 系统提示和对话历史会合并为单次 ACP 用户提示。ACP 没有通用 system prompt 字段，因此系统提示以文本形式附在 prompt 前。
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
