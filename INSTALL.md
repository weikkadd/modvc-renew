# ModVC 自动续期 - 安装说明

本包包含 renew.mjs（脚本）、config.sample.json（配置样例）、README.md（完整文档）、INSTALL.md（本说明）。

## 快速开始
1. 要求 Node 18+：node -v 检查；没有则参考 README 安装
2. 解压后：mv config.sample.json config.json && chmod 600 config.json
3. 编辑 config.json 填入你自己的 refreshToken（必需）和可选的 tgBotToken/tgChatId，方法见 README
4. 验证：node renew.mjs（看到 当前套餐 free... 或 SUCCESS 续期成功 即正常）
5. 加 cron 每小时执行：0 * * * * cd /opt/modvc-renew && /usr/bin/node renew.mjs >> /opt/modvc-renew/cron.log 2>&1
   （node 绝对路径用 which node 查）

## 注意
- 只在一台机器跑，refresh token 会轮换，多台互踢会 INVALID_REFRESH_TOKEN
- 不要把真实 config.json 发给别人；本包为 sample，无你的真实凭据
- 完整说明见 README.md
