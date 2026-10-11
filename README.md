# ModVC 免费套餐自动续期

> 无需浏览器，纯 HTTP 请求完成 [panel.modvc.org](https://panel.modvc.org) 免费套餐的自动续期（每次 +7 天）。

每小时跑一次：用 Firebase refresh token 换 1 小时有效的 ID token → 查 `/tier` 剩余时间 → 剩余 ≤阈值时调 `POST /renew-free`。

## 目录结构

```
modvc-renew/
├── renew.mjs            # 续期脚本（Node 18+，纯 HTTP）
├── config.sample.json   # 配置样例（复制为 config.json 后填入真实 token）
├── README.md            # 完整文档
└── INSTALL.md           # 快速安装说明
```

## 快速开始

```bash
# 1. clone
git clone https://github.com/weikkadd/modvc-renew.git
cd modvc-renew

# 2. 配置
cp config.sample.json config.json
chmod 600 config.json
# 编辑 config.json 填入 refreshToken（必需）和可选的 TG 通知

# 3. 验证
node renew.mjs
# 看到「当前套餐 free，到期 ...（剩余 X 小时）」即成功

# 4. 加 cron 每小时执行
crontab -e
# 加入：
# 0 * * * * cd /opt/modvc-renew && /usr/bin/node renew.mjs >> /opt/modvc-renew/cron.log 2>&1
```

> **Node 18+ 必需**（脚本用内置 fetch）。`which node` 查绝对路径，nvm 安装的 node 不在 cron PATH 里必须写绝对路径。

## config.json 字段

| 字段 | 必需 | 说明 |
|------|------|------|
| `refreshToken` | ✅ | Firebase 长期凭据，获取方式见下方 |
| `idToken` | ❌ | 临时 token，仅调试用，留空 |
| `renewWithinHours` | ❌ | 剩余多少小时内触发续期，默认 `2`。LXC/云主机建议设 `24`（续期窗口拉长，每小时重试 24 次） |
| `tgBotToken` | ❌ | Telegram Bot Token，与 `tgChatId` 配对 |
| `tgChatId` | ❌ | Telegram 接收目标（私聊 chat id 或 `群名/@频道名`） |
| `notifyTzOffset` | ❌ | 通知时区，数字小时，默认 `8`（UTC+8） |
| `notifyEveryRun` | ❌ | `false`（默认）状态不变不推送；`true` 每轮都推 |
| `notifyWebhook` | ❌ | 续期成功/失败时 POST `{"text":"..."}` 到该 URL（Bark、Server酱等）。已配 TG 时此项不生效 |

## 如何获取 refreshToken

1. 浏览器打开 [panel.modvc.org](https://panel.modvc.org) 并登录
2. F12 → Console 执行：

```js
const req = indexedDB.open('firebaseLocalStorageDb');
req.onsuccess = () => {
  const get = req.result.transaction('firebaseLocalStorage', 'readonly')
    .objectStore('firebaseLocalStorage').getAll();
  get.onsuccess = () => {
    const e = get.result.find(e => e.value?.stsTokenManager?.refreshToken);
    e ? (console.log(e.value.stsTokenManager.refreshToken),
         copy(e.value.stsTokenManager.refreshToken))
      : console.error('未找到，请确认已登录');
  };
};
```

3. 输出的 `AMf-` 开头字符串即为 refreshToken，填入 config.json

## 通知示例

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

## ⚠️ 注意事项

- **只在一台机器上跑** — refresh token 会轮换，多台互踢导致 `INVALID_REFRESH_TOKEN`
- **不要把 config.json 提交到 Git** — 已在 .gitignore 中排除
- **token 失效** — 报 `FATAL refresh token 已失效` 通常是登出过或 Google 撤销会话，按上方步骤重新获取

## 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 正常（续期成功 / 未到时间 / 未到资格） |
| `1` | 认证或配置问题（需人工处理） |
| `2` | 网络/服务端临时错误（等下次 cron 重试） |

## License

MIT
