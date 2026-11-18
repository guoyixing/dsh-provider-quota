# DSH Provider Quota · 供应商额度

DeepSeek Harness (DSH) 插件：在左侧边栏底部、设置与账户区域上方显示供应商余额、订阅额度与本地 Token 用量。

**npm:** [`@keyboard-dog/dsh-provider-quota`](https://www.npmjs.com/package/@keyboard-dog/dsh-provider-quota) · **源码:** [guoyixing/dsh-provider-quota](https://github.com/guoyixing/dsh-provider-quota)

本项目与 npm 上未带 scope 的 `dsh-provider-quota` 是不同项目，安装时请使用完整包名。

## 安装

在 DSH 插件管理器中安装 npm bundle，包名填写：

```text
@keyboard-dog/dsh-provider-quota
```

也可以让 DSH 助手“安装插件 @keyboard-dog/dsh-provider-quota”，并批准插件管理器操作。安装后刷新页面，到 **设置 → 供应商额度** 配置显示条目和刷新间隔。

这是 DSH bundle，不是独立 Web 应用；单独运行 `npm install` 不会自动激活 DSH 插件。Host 使用 Node 内置模块，前端 React 由 DSH 提供，无需额外安装依赖。

## 功能与数据边界

- DeepSeek API：使用对应供应商明确配置的凭据查询余额；不会回退到其他供应商的 Key。
- DeepSeek 登录账户：通过 DSH 的账户服务读取余额。
- Factory (Droid)：检测 Factory 供应商，读取 `dsh-factory-provider` 插件的额度接口。
- 订阅插件：经已授权的 RPC 连接读取 `dsh-plugin-subscriptions` 的账号及用量。支持的路由包括 Codex、Claude、Grok、Copilot、Antigravity，实际可用窗口由上游插件和账号决定；查询默认账号，无账号时隐藏，查询失败时保留上次已知额度并标注（没有历史数据则显示错误）。
- 千问 / Qwen：统计启用本插件后经 DSH 的 Token 用量，按供应商路由独立累计。识别路由名中的 `qwen`、`token-plan`、`qianwen`，也识别配置地址位于 `qianwenaiapi.com` / `dashscope.aliyuncs.com` 及其子域的自定义路由。原生 Qwen 路由也可显示。**这是本地累计已用 tokens，不是官方剩余 Credits，也不包括其他应用或之前的历史请求。** 保留[千问控制台](https://platform.qianwenai.com/home/analytics/token-plan/individual)链接；不采集控制台 Cookie。自定义中转域名且路由名不包含上述标识时无法自动识别；不根据模型名称猜测供应商归属。
- 其他供应商：没有已实现的余额接口时显示“不支持查询”，可在设置中隐藏。

额度面板跟随侧栏宽度变化；侧栏收起时，如果 DSH 仍显示底部图标，可点击图标打开浮层。设置支持逐条显示/隐藏、数据来源开关、本地统计开关、重置统计和 5–3600 秒刷新间隔（默认 60 秒）。显示条目保存成功后立即更新当前页面的侧栏，其他页面在下次轮询时更新。手动刷新也会请求订阅插件强制检查可见订阅的额度；实际数据仍受上游缓存及限流策略影响。

插件注册的额度源随所属 context 销毁而移除。内置桥接依据适配器列表与配置重新对账：提供方移除后，其对应来源不再被发现时自动删除，并在面板下一次刷新时消失。若其他插件遗留了适配器配置，仍可能显示查询错误，需要移除该遗留配置。

## 千问统计口径与操作

在 **设置 → 供应商额度 → 千问本地用量** 开启统计，使用已识别的千问供应商发起新请求。侧栏显示该路由的“本地已用 … tokens”，悬停详情可查看请求数及统计开始时间。请求结束后计数立即可由 Host 读取；侧栏在下次轮询或点击刷新时更新。

- 仅统计上游实际返回的有效 `usage`，没有用量报告的失败/中断请求不估算；请求数表示收到用量报告的调用次数，**不等于成功请求数**。
- 每个流采用最后一份有效累计报告，只计一次。流报错或取消前若已收到用量，则仍记录；不更改模型返回的任何 chunk。
- 当前 DSH pi-ai 适配器的 `inputTokens` 是未缓存输入，缓存读取/写入分别展示，输出包含推理 tokens。总计优先使用上游 `totalTokens`；缺失时才相加未缓存输入、输出、缓存读写，避免把缓存重复加进总计。
- 暂停统计保留已有数据，不追补暂停期间用量。暂停或重置前已开始的在途调用不会在结束后补写旧数据。重置需要确认，清除所有路由的本地统计，不影响官方套餐。
- 旧版已有的按路由存储数据仍可读取；现在每行只显示自己的数据，不再把所有千问路由的合计重复展示。旧版可能多计的数据无法自动校正，可确认后手动重置重新统计。

每次收到完整用量后即通过临时文件原子替换保存；写入失败不阻断模型调用，保留待写数据在刷新/卸载时重试，并记录警告。重置持久化失败会返回错误而非显示成功。若进程在尚未收到上游用量报告时异常退出，该请求无法补计。

## 本地数据与安全

偏好及统计保存在 `$DSH_HOME/plugins/provider-quota/`（未设置 DSH_HOME 时为 `~/.dsh/plugins/provider-quota/`）的 `prefs.json` 与 `usage.json`，不随 npm 包发布。使用相同 DSH_HOME 的 profiles 共享这两份数据；不支持多个 Host 同时写入同一 DSH_HOME 的累计统计（没有跨进程锁与合并，可能相互覆盖计数）。卸载插件不会自动删除统计。

插件只保存设置和累计用量，不保存供应商密钥、提示词或模型输出。余额查询仍会向相应供应商发送必要的认证信息；请仅配置你信任的供应商地址。

本插件通过 DSH Connection 的 `/api` 精确路由访问 Host，使用 DSH 的请求来源校验和 owner 身份验证；写操作还要求 JSON 内容类型。桌面客户端在转发时省略 `Origin`，由 DSH 的会话认证识别，不需要放宽成匿名写入。

## 兼容性与已知限制

依赖 DSH 的 `sidebar.footer.action`、`settings.section`、`connection.rpc`、`llm/stream` 和 Host webServer 服务。第三方插件接口变化可能影响桥接。当前自动测试覆盖模拟 Host 与 Client 行为，不替代各 DSH 版本、浏览器或真实账号的集成测试；本次发布未重新完成浏览器端真实额度回归。没有声明未经验证的最低 DSH 版本。

## 为其他插件注册额度源

插件注入 `providerQuota` 服务后，可注册自己的来源；请使用独立命名空间 ID，不要占用内置 `provider:` / `plugin:` 前缀。

```js
export const inject = ['providerQuota'];
export function apply(ctx) {
  ctx.providerQuota.register({
    id: 'my-plugin:quota',
    label: 'My provider',
    order: 0,
    async fetch() {
      return { status: 'ok', remaining: '80%', usedPercent: 20 };
    },
  });
}
```

注册生命周期绑定调用方 context；卸载时自动清理。`fetch` 应及时完成，自行实现网络超时，并且不要把密钥放入返回数据。

## 开发与发布

```bash
npm run check
npm test
npm pack --dry-run
npm publish --access public --registry=https://registry.npmjs.org
```

发布白名单仅包含 Host、Client、bundle patch、语言资源、图标、README 与许可证；测试、缓存、本机配置不打包。正式发布会先运行语法检查与测试。

## License

MIT © 2026 敲代码的旺财
