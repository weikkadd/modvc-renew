# ModVC 免费套餐自动续期

无需浏览器，纯 HTTP 请求完成 `panel.modvc.org` 免费套餐的自动续期（每次 +7 天）。
每小时跑一次：用 Firebase refresh token 换 1 小时有效的 ID token → 查 `/tier` 剩余时间 → 剩余 ≤2 小时时调 `POST /renew-free`（body `{"adToken":null}`）。

## 在 Linux VPS 上部署

config.json 里已包含有效的 refreshToken，解压即用，不需要再去浏览器提取。

1. **要求 Node 18+**（脚本用内置 fetch）。没有就装，任选其一：

   ```bash
   node -v   # 检查
   # Debian/Ubuntu（系统源或 NodeSource 均可）
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs
   ```

2. **上传 zip 并解压**（scp / SFTP 到 VPS 后）：

   ```bash
   mkdir -p /opt/modvc-renew && cd /opt/modvc-renew
   unzip ~/modvc-renew.zip
   chmod 600 config.json   # 里面有凭据，收紧权限
   ```

3. **手动跑一次验证**：

   ```bash
   node renew.mjs
   ```

   看到 `当前套餐 free，到期 ...（剩余 X 小时）` + `本次不续期`（或 `SUCCESS 续期成功`）即成功。

4. **加 cron，每小时跑一次**：`crontab -e` 加入一行：

   ```
   0 * * * * cd /opt/modvc-renew && /usr/bin/node renew.mjs >> /opt/modvc-renew/cron.log 2>&1
   ```

   - node 的绝对路径用 `which node` 查；**nvm 安装的 node 不在 cron 的 PATH 里，必须写绝对路径**
   - `renew.log` 是脚本自己写的运行日志；`cron.log` 兜底接 node 崩溃等 stderr 输出

## ⚠️ 只在一台机器上跑

Firebase refresh token 每次使用都可能轮换。如果 VPS 和本机 Windows 同时各跑一个定时任务，两边争抢刷新会导致其中一方日后报 `INVALID_REFRESH_TOKEN`。**把任务搬到 VPS 后，请删除本机的计划任务：**

```bat
schtasks /Delete /TN "ModVC Renew" /F
```

（本机脚本在 `D:\project\modvc-renew\`，留着不跑没关系。）

## token 失效了怎么办

报 `FATAL refresh token 已失效` 通常是你在面板上登出过、或 Google 撤销了会话。在本机浏览器打开 panel.modvc.org 登录后，F12 Console 执行下面片段，把输出的 `AMf-` 开头字符串（无点、约 300 字符）更新进 config.json 的 `refreshToken`：

```js
const req = indexedDB.open('firebaseLocalStorageDb');
req.onsuccess = () => {
  const get = req.result.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll();
  get.onsuccess = () => {
    const e = get.result.find(e => e.value?.stsTokenManager?.refreshToken);
    e ? (console.log(e.value.stsTokenManager.refreshToken), copy(e.value.stsTokenManager.refreshToken))
      : console.error('未找到，请确认已登录');
  };
};
```

注意别截图覆盖剪贴板 😄，复制完直接粘贴即可。

## config.json 字段

| 字段 | 说明 |
|---|---|
| `refreshToken` | Firebase 长期凭据，已填好有效值 |
| `idToken` | 临时 token，仅调试用，留空即可 |
| `renewWithinHours` | 剩余多少小时内触发续期，默认 2。**服务端在剩余 ≤24h 时才放行续期**（实测确认，429 = 未到资格）。LXC / 云主机这类可能宿主机停机的环境建议设 `24`：续期窗口从 2 小时拉长到一整天，且每小时跑一次意味着失败有 24 次自动重试机会 |
| `tgBotToken` | 可选。Telegram Bot Token（如 `123456:ABC-...`），与 `tgChatId` 配对使用 |
| `tgChatId` | 可选。Telegram 接收目标（私聊 chat id 或 `群名/@频道名`）。脚本直连 `api.telegram.org/bot<token>/sendMessage`，仅在**续期成功 / 401 认证失效 / 未预期异常**时推送，未到续期窗口不会打扰 |
| `notifyTzOffset` | 通知里时间的显示时区，数字小时，默认 `8`（北京时间 UTC+8）。不影响续期判断，只影响展示 |
| `notifyEveryRun` | `false`（默认）：本轮无需续期时**只在状态变化后推一次**，避免每小时刷屏；`true`：每轮都推（每小时一条） |
| `notifyWebhook` | 可选。续期成功/失败时 POST `{"text":"..."}` 到该 URL（Bark、Server酱、企业微信机器人等）。**已配 TG 时此项不生效** |

> 通知说明：`tgBotToken` + `tgChatId` 优先于 `notifyWebhook`；两者都填则只走 TG。两种方式都会检查 HTTP 状态码并把结果写进 `renew.log`（旧版本不检查，服务端返回 4xx 也会误报「通知已发送」）。


## 通知格式

续期成功 / 无需续期 / 认证失效 / 续期失败 四种状态统一推送如下结构，**所有取值均来自当次 `/tier` 探测或服务端响应，无硬编码**：

```
🇧🇩 ModVC 续期通知

📊 状态: ⏭️ 本轮无需续期
📦 套餐: free
🧠 规格: 256MB / 0.25 cores / 24-7
📅 到期时间: 2026-10-12 18:00 (UTC+8)
⏳ 剩余: 162小时1分
⏳ 下次可续期: 138小时1分后
🕒 执行时间: 2026-10-05 23:59:16 (UTC+8)
📌 站点限制到期前 24 小时开放续期，下次自动处理
```

取值来源：`套餐/规格/到期时间` 取自 `GET /tier`（`tier`、`features.ram|cpu|uptime`、`expiresAt`）；
`剩余` 由 `expiresAt - 当前时间` 算出；`下次可续期` 优先用服务端返回的 `canRenewAt`，否则按 `renewWithinHours` 反推；
末行的开放时长直接取 `renewWithinHours`。渲染后的正文也会写进 `renew.log`，便于核对格式。

去重状态记录在 `.notify_state`，状态不变则不推送。



## 退出码（供排查）

- `0` 正常（续期成功 / 未到时间 / 未到资格，未到资格时服务端返回 429 属正常）
- `1` 认证或配置问题（需人工处理，日志会明确提示）
- `2` 网络/服务端临时错误（等下次 cron 自动重试即可）

## 运行日志

`renew.log` 追加记录每次运行结果；成功时格式为 `SUCCESS 续期成功: Renewed for 7 days!` 并附新到期时间。
