# deepseek-usage
> 🤖 **AI 辅助生成声明**：本插件代码由 AI 辅助完成，所有功能实现均经过人工审查、测试和调整后发布。

在 DSH Web GUI 的**会话头部**显示 **DeepSeek API 账户余额/剩余额度**的插件（当前仅支持 DeepSeek API）。

- 数据来源：DeepSeek 官方 [`GET /user/balance`](https://api-docs.deepseek.com/api/get-user-balance/) 接口。
- API Key 只留在宿主进程：通过 `credentials` 服务（与 Web Models 设置页同一凭据通道）逐次解析，浏览器端永远拿不到 Key。
- 宿主每 60 秒刷新一次缓存，浏览器徽标轮询同一个源上的 `/deepseek-usage/balance`，点击徽标展开明细（总余额 / 充值余额 / 赠送余额 / 可用状态 / 更新时间 / 手动刷新）。

## 结构

```
deepseek-usage/
├── package.json        # dsh.bundle.patch + dsh.client 声明（同一个 loader 条目挂载宿主与浏览器两半）
├── cordis.patch.yml    # bundle 补丁层：插入 deepseek-usage 宿主行
├── lib/index.js        # 宿主半：拉取余额、缓存、提供 /deepseek-usage/* 路由
├── lib/client.js       # 浏览器半：会话头部余额徽标（window.__ModuleLoader__ 格式）
└── README.md
```

## 安装

在仓库根目录（本目录的上一级）执行：

```powershell
dsh plugin --profile web add <plugin-dir>
```

该命令会用 pnpm 把插件安装进 `~/.dsh/profiles/web`，并因 `dsh.bundle.patch` 声明自动把它追加到 `dsh.profile.bundles` 层栈。

**然后重启 `dsh web`**（插件在进程启动时挂载；重启后刷新页面即可在会话头部看到余额徽标）。

## 卸载

```powershell
dsh plugin --profile web remove deepseek-usage
```

再重启 `dsh web`。

## 配置

`cordis.patch.yml` 中的 `config` 可覆盖：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭据引用/环境变量名 |
| `baseURL` | `https://api.deepseek.com` | DeepSeek API 基址（自动追加 `/user/balance`） |
| `apiKey` | 无 | 字面量 Key（优先于凭据库；不建议使用） |
| `refreshIntervalMs` | `60000` | 宿主刷新间隔（毫秒） |

> 当前所有配置只作用于 DeepSeek；后续接入其它厂商时，把 provider 抽象成一层即可复用同一套「宿主拉取 + 浏览器徽标」结构。

## 已知限制

- DeepSeek 官方没有提供「累计 token 消耗」的查询接口，`/user/balance` 返回的是账户余额；因此本插件显示的是余额/剩余额度而非 token 数。
- 没有 API Key 时徽标显示「余额获取失败」，展开可看到原因。
