# deepseek-usage

> 🤖 **AI 辅助生成声明**：本插件代码由 AI 辅助完成，所有功能实现均经过人工审查、测试和调整后发布。

在 DSH Web GUI 的**输入框下方那一排的最右侧**（composer dock，那一排左侧是「缓存命中 / tok/s」统计）显示 **DeepSeek API 账户余额/剩余额度**的插件（当前仅支持 DeepSeek API）。

- 数据来源：DeepSeek 官方 [`GET /user/balance`](https://api-docs.deepseek.com/api/get-user-balance/) 接口。
- API Key 只留在宿主进程：通过 `credentials` 服务（与 Web Models 设置页同一凭据通道）逐次解析，浏览器端永远拿不到 Key。
- 拉取策略（避免"刚打开时一段时间没数据"）：
  - 宿主：启动即拉取，成功后每 60 秒一次；**失败会自己快速重试**（2s → 5s → 15s → 30s，之后并入常规节奏），并且浏览器每次读取时若发现快照不健康或已过期就顺手触发一次刷新；失败时**保留上次成功值**，快照带 `stale: true`。
  - 浏览器：不是固定 60 秒轮询，而是自适应——首次读数到位前每 1.2 秒拉一次，之后进入 60 秒稳态；连续失败按 2s/4s/8s/15s/30s 退避；**切回页面/窗口聚焦时立即重拉**。
  - 因此打开页面时通常 1～3 秒内就有数字（取决于 DeepSeek 接口本身耗时）；若中途拉取失败，徽标继续显示上次金额（红点 + 面板里提示"显示的是上次成功获取的数据"），而不是空掉。
- **鼠标悬停在徽标上展开明细**（明细向上、向左弹出，移开自动关闭，键盘 Tab 聚焦同样展开），含总余额 / 充值余额 / 赠送余额 / 可用状态 / 更新时间 / 手动刷新。
- 排版与那一排 pill 对齐：字号/行高取应用的内容次级字号变量（`--dsh-content-font-size-secondary - 1px`、`20px + --dsh-content-font-delta-secondary`），不要改回 `font: inherit`——那样会继承外壳默认字号，比旁边的 pill 明显偏大。明细面板与其中按钮用同一套字号。
- 位置由 `lib/client.js` 里 `ctx.slots.register({ name: 'conversation.composer.dock', order: 10 })` 决定；靠最右由 wrapper 的 `order: 1`（排到上下文占用环之后）+ `marginLeft: auto`（吃掉整行剩余空隙）实现。注意那一排是居中 flex，所以钉住徽标后「tok/s / 缓存命中 / 占用环」会整体靠左——这是单个居中 flex 行的必然结果。想挪到别处只改这一个槽位名（例如侧边栏底部的 `sidebar.footer.action`，那种情况要去掉 `order`/`marginLeft`、并让面板改回向下弹出）。

## 结构

```
deepseek-usage/
├── package.json        # dsh.bundle.patch + dsh.client 声明（同一个 loader 条目挂载宿主与浏览器两半）
├── cordis.patch.yml    # bundle 补丁层：插入 deepseek-usage 宿主行
├── lib/index.js        # 宿主半：拉取余额、缓存、提供 /deepseek-usage/* 路由
├── lib/client.js       # 浏览器半：输入框下方那一排的余额徽标（window.__ModuleLoader__ 格式）
└── README.md
```

## 安装

在**本插件目录内**执行（`--profile` 换成你实际使用的 profile，桌面版是 `desktop`）：

```powershell
dsh plugin --profile desktop add .
```

该命令会用 pnpm 把插件安装进 `$DSH_HOME/profiles/<profile>`，并因 `dsh.bundle.patch` 声明自动把它追加到 `dsh.profile.bundles` 层栈。

**然后重启 DeepSeek Harness**（插件在进程启动时挂载；重启后刷新页面即可在输入框下方那一排看到余额徽标）。

> 桌面版若 `dsh` 不在 PATH，可直接用应用自带的 `resources\runtime\cli\bin\dsh.cmd`。

## 卸载

```powershell
dsh plugin --profile desktop remove deepseek-usage
```

再重启 DeepSeek Harness。

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

## 注意

- 插件源码即本仓库；安装后 profile 以 `link:` 依赖指向你本机 clone 下来的插件目录。请不要删除或移动该目录，否则下次启动会报模块缺失。
- 仓库已用 git 跟踪全部插件文件。做 `git clean`、`git checkout -- .`、`git reset --hard` 这类操作前，请确认改动都已提交，避免误删未跟踪文件。
