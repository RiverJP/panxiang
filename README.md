# 盼享随充

印尼话费/流量套餐充值系统，包含独立用户前台、运营管理后台、ReloadN 供应商对接和微信 JSAPI 支付。

## 主要功能

- 前台：运营商自动识别，话费/流量和运营商筛选，微信内 JSAPI 支付。
- 管理后台：商品同步、上下架、文案和定价、订单与系统状态管理。
- 商品同步：自动跟随分页，只保留印尼主要运营商的话费和流量套餐。
- 自动价格：每 8 小时检查 IDR/CNY 汇率，同时支持单 SKU 手动售价。
- 自动运维：每日检查商品同步，供应商停用/消失商品自动下架。
- 数据：订单使用 SQLite（WAL + 同步事务）持久化，商品、汇率和管理审计日志保存在服务器 `data/`。
- 支付可靠性：微信支付成功后先持久化，再异步提交充值；网络异常会自动重试，供应商回调按事件 ID 和版本号幂等处理。

## 本地运行

需要 Node.js 22.13 或更高版本（订单存储使用 Node 内置 SQLite）。

```powershell
Copy-Item .env.example .env
npm start
```

程序启动时会自动读取项目根目录的 `.env`（系统环境变量优先）。打开 `http://localhost:3000`。

## 运营后台安全登录

后台地址为 `/admin/`，未登录时会自动跳转到独立登录页 `/admin/login`。登录需要管理员账号、密码、图片验证码和 Google Authenticator 6 位动态码。后台静态资源和所有管理 API 都需要登录会话。

首次部署时在项目目录运行：

```bash
node scripts/generate-admin-auth.mjs
```

脚本会一次性显示随机强密码、密码哈希和 Google Authenticator 设置密钥。把输出的 `ADMIN_USER`、`ADMIN_PASSWORD_HASH`、`ADMIN_TOTP_SECRET` 和 `ADMIN_SESSION_TTL_SECONDS` 写入服务器 `.env`，再在 Google Authenticator 中选择“输入设置密钥”，类型选择“基于时间”。完成后重启服务。

后台登录采用 HttpOnly + Secure + SameSite=Strict 会话 Cookie；管理写接口还会校验 CSRF Token。连续 5 次登录失败会锁定 15 分钟。生产环境必须使用 HTTPS，并确保 Node 的 3000 端口不直接暴露公网，只允许 Nginx 反向代理访问。

## 通过 GitHub 部署与更新

首次在服务器部署：

```bash
cd /opt
git clone https://github.com/RiverJP/panxiang.git panxiang-recharge
cd panxiang-recharge
cp .env.example .env
node scripts/generate-admin-auth.mjs
```

将脚本生成的后台配置以及微信支付、ReloadN 配置写入 `.env`，然后启动或重启 `panxiang.service`。

后续更新代码：

```bash
cd /opt/panxiang-recharge
git pull --ff-only origin main
systemctl restart panxiang.service
systemctl status panxiang.service --no-pager
```

`.env`、证书、私钥、运行数据和日志已加入 `.gitignore`，不会提交到 GitHub。服务器更新前仍建议备份 `.env` 和 `data/`。

## 生产注意事项

- `.env`、API 密钥、微信私钥和证书只保存在服务器，不得提交到 Git。
- 只向 Nginx 开放 80/443，Node 3000 端口不对公网开放。
- 更新前备份 `.env`、`keys/` 和 `data/`；旧版 `data/orders.json` 会在首次启动时自动迁移到 `data/orders.sqlite`，原文件不会删除。
- 公共套餐接口不返回买入价、供应商原始字段或后台定价配置。
