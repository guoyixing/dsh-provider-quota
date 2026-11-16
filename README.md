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
- 订阅插件：经浏览器已授权的 RPC 连接读取 `dsh-plugin-subscriptions` 的账号及用量。支持的路由包括 Codex、Claude、Grok、Copilot、Antigravity，实际可用窗口由上游插件和账号决定；查询默认账号，无账号时隐藏，查询失败显示错误。
- 千问 / Qwen：统计启用本插件后、经 DSH 且路由名包含 `qwen`、`token-plan` 或 `qianwen` 的 Token 用量。**这是本地累计用量，不是官方剩余 Credits，也不包括其他应用或之前的历史请求。** 多个千问路由目前展示合计值。保留[千问控制台](https://platform.qianwenai.com/home/analytics/token-plan/individual)链接查看官方额度；不采集控制台 Cookie。
- 其他供应商：没有已实现的余额接口时显示“不支持查询”，可在设置中隐藏。

额度面板跟随侧栏宽度变化，侧栏收起时可点击图标打开浮层。设置支持逐条显示/隐藏、数据来源开关、本地统计开关、重置统计和 5–3600 秒刷新间隔（默认 60 秒）。当前页面保存设置后立即重载；其他页面在下次轮询时更新。

插件注册的额度源随所属 context 销毁而移除。内置桥接依据适配器列表与配置重新对账：提供方移除后，其对应来源不再被发现时自动删除，并在面板下一次刷新时消失。若其他插件遗留了适配器配置，仍可能显示查询错误，需要移除该遗留配置。

## 本地数据与安全

偏好及统计保存在 `$DSH_HOME/plugins/provider-quota/`（未设置 DSH_HOME 时为 `~/.dsh/plugins/provider-quota/`）的 `prefs.json` 与 `usage.json`，不随 npm 包发布。使用相同 DSH_HOME 的 profiles 共享这两份数据。卸载插件不会自动删除统计。

插件只保存设置和累计用量，不保存供应商密钥、提示词或模型输出。余额查询仍会向相应供应商发送必要的认证信息；请仅配置你信任的供应商地址。

本插件面向本机 DSH GUI：HTTP 接口校验回环连接、Host 和浏览器 Origin；写操作还要求同源 Origin 与 JSON 内容类型。这不是独立用户认证系统，不隔离同机进程；不支持通过远程地址或反向代理公开这些接口。

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
