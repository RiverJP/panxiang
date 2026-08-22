# 盼享随充 MVP

这是服务号“新注册公众号”的印尼话费/流量充值展示页和后端骨架。

## 已准备

- 手机端充值展示页：`public/index.html`
- 套餐目录接口：`GET /api/catalog`
- 创建订单接口：`POST /api/orders`
- 订单查询接口：`GET /api/orders/:id`
- 供应商回调接口：`POST /api/provider/webhook`
- ReloadN 供应商适配器：`src/provider.js`

## 本地运行

```powershell
Copy-Item .env.example .env
npm start
```

打开 `http://localhost:3000`。

## 运营后台安全登录

后台地址为 `/admin.html`，未登录时会自动跳转到独立登录页 `/admin-login.html`。登录需要管理员账号、密码、图片验证码和 Google Authenticator 6 位动态码。

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

## 接真实供应商 API 前必须确认

当前 `src/provider.js` 使用的是**适配器占位结构**，没有猜测 ReloadN 的真实下单路径、产品字段或签名算法。需要从供应商控制台/API 文档确认：

1. 产品查询接口和产品编码；
2. 下单 URL、鉴权方式、请求字段；
3. 成功/失败状态字段；
4. webhook URL、签名算法和签名请求头；
5. 查询订单和退款接口。

确认后只需修改 `src/provider.js`，不要把供应商 token 写进前端。

## 生产上线前还要补

- 微信 JSAPI 下单和支付回调验签；
- MySQL/PostgreSQL 持久化，不能使用当前内存订单表；
- 订单幂等、超时、退款和对账；
- HTTPS、ICP备案域名、微信网页授权域名及支付授权目录；
- 供应商 webhook 签名验证和 IP/访问控制；
- 日志脱敏，手机号不要明文写入公开日志。
