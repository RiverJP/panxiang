# 服务号内 H5 与微信 JSAPI 支付接入、验收说明

本文按当前项目代码和生产域名整理，目标链路是：

```text
服务号菜单 → https://reloadb.com/
            → 静默网页授权取得该服务号下的 OpenID
            → 创建本地订单
            → 微信 JSAPI 支付
            → 微信支付回调
            → ReloadN 充值下单及结果回调
            → 用户查看订单状态
```

公众平台和微信支付商户平台会调整导航名称。下文给出的菜单路径只用于定位；如果后台显示不同，以当前界面中同名功能为准。

## 一、配置总表

| 配置位置 | 配置项 | 本项目应填 | 格式要点 |
| --- | --- | --- | --- |
| 微信公众平台 | 自定义菜单的跳转 URL | `https://reloadb.com/` | 必须使用 HTTPS；当前支付页面就是首页 |
| 微信公众平台 | 网页授权域名 | `reloadb.com` | 只填域名，不带 `https://`、端口或路径 |
| 微信公众平台 | JS 接口安全域名 | `reloadb.com` | 只填域名；与商户平台的“JSAPI 支付授权目录”不是一回事 |
| 微信支付商户平台 | 绑定的 AppID | 当前认证服务号的 `AppID` | 必须与服务器 `WECHAT_APPID` 完全一致，并完成服务号侧确认 |
| 微信支付商户平台 | JSAPI 支付授权目录 | `https://reloadb.com/` | 带协议、以 `/` 结尾；不要继续使用旧的 `http://reloadb.com/pay/` |
| 服务器 `.env` | 微信支付通知地址 | `https://api.reloadb.com/api/wechat/notify` | 完整公网 HTTPS URL、无查询参数、无需登录 |
| ReloadN 控制台 | 供应商 Webhook 地址 | `https://api.reloadb.com/api/provider/webhook` | 这是充值结果回调，不是微信支付回调 |

根目录形式的 JSAPI 授权目录 `https://reloadb.com/` 可以覆盖该域名下的支付页面。以后即使前台改为 `/recharge/`，也不必为了子路径再增加一条；如果将支付页面迁到其他子域名，则需要单独重新配置。

## 二、微信公众平台配置

### 1. 确认服务号身份和 AppID

1. 登录当前已认证的服务号后台。
2. 在“设置与开发/开发接口管理/基本配置”一类页面找到开发者 ID（AppID）。
3. 确认它与服务器 `.env` 中的 `WECHAT_APPID` 完全一致。
4. `WECHAT_APP_SECRET` 使用该服务号的 AppSecret；它不是微信支付 API v3 密钥。

JSAPI 支付需要使用已认证服务号（或微信支持的其他合格主体账号）。不能拿另一个订阅号的 AppID 获取 OpenID，再用当前服务号绑定的商户号支付。

### 2. 配置网页授权域名

当前代码使用静默授权 `snsapi_base` 获取 OpenID，回调地址由 `PUBLIC_BASE_URL` 生成：

```text
https://reloadb.com/api/wechat/oauth/callback
```

在公众平台的“网页授权域名”处填：

```text
reloadb.com
```

如果平台要求校验文件：

1. 下载平台给出的 `MP_verify_*.txt` 文件，不要修改文件名和内容。
2. 上传到服务器项目的 `public/` 根目录，例如：

   ```text
   /opt/panxiang-recharge/public/MP_verify_xxxxx.txt
   ```

3. 先在浏览器确认 `https://reloadb.com/MP_verify_xxxxx.txt` 返回原始文本和 HTTP 200，再回公众平台点击保存/验证。

### 3. 配置 JS 接口安全域名

填：

```text
reloadb.com
```

当前支付按钮直接调用 `WeixinJSBridge.getBrandWCPayRequest`，并未使用需要 `wx.config` 的公众号 JS-SDK，所以该项不是当前支付签名的替代品。仍建议配置，便于以后接入分享、定位、扫一扫等 JS-SDK 能力。若平台再次要求校验文件，处理方式与网页授权域名相同。

### 4. 配置服务号菜单

在服务号后台的自定义菜单功能中新增入口，例如：

```text
菜单名称：印尼充值
动作类型：跳转网页
网页地址：https://reloadb.com/
```

保存并发布菜单后，必须用普通关注者账号从服务号会话里点击该菜单测试。直接在电脑浏览器打开，只能验证普通页面，不能完成真实的公众号 OpenID 和 JSAPI 支付验收。

## 三、微信支付商户平台配置

### 1. 关联服务号 AppID

1. 在商户平台的“产品中心/APPID 账号管理”一类页面，由商户超级管理员发起关联。
2. 选择或输入当前认证服务号的 AppID。
3. 回到服务号后台的“微信支付/商户号管理”一类页面确认待关联申请。部分后台会把入口放在“广告与服务”下面。
4. 回商户平台确认状态已经是关联成功，而不是待确认。

这是双向确认。服务器中下面两个值必须正好属于这组已关联关系：

```dotenv
WECHAT_APPID=<已关联服务号 AppID>
WECHAT_MCHID=<关联成功的微信支付商户号>
```

### 2. 开通 JSAPI 支付并配置授权目录

在商户平台“产品中心/开发配置/JSAPI 支付”一类页面确认 JSAPI 支付已开通，然后将授权目录配置为：

```text
https://reloadb.com/
```

注意：

- 必须是备案域名，不能填公网 IP。
- 必须与页面实际协议一致；生产站点是 HTTPS，就不能填 HTTP。
- 目录必须以 `/` 结尾。
- 当前调用 `getBrandWCPayRequest` 的页面是 `https://reloadb.com/`，因此旧配置 `http://reloadb.com/pay/` 不匹配。
- 商户平台配置通常需要短暂生效时间；刚修改后可等待数分钟再重试。

### 3. 服务器支付参数

当前代码需要以下环境变量：

```dotenv
PUBLIC_BASE_URL=https://reloadb.com
WECHAT_APPID=<服务号 AppID>
WECHAT_APP_SECRET=<服务号 AppSecret>
WECHAT_MCHID=<微信支付商户号>
WECHAT_API_V3_KEY=<32 字节 API v3 密钥>
WECHAT_MCH_SERIAL_NO=<商户 API 证书序列号>
WECHAT_PRIVATE_KEY_PATH=/opt/panxiang-recharge/keys/apiclient_key.pem
WECHAT_PLATFORM_CERT_PATH=/opt/panxiang-recharge/keys/wechatpay_platform_public_key.pem
WECHAT_NOTIFY_URL=https://api.reloadb.com/api/wechat/notify
```

文件用途不要混淆：

- `WECHAT_PRIVATE_KEY_PATH` 指向商户 API 私钥 `apiclient_key.pem`，不是 `apiclient_cert.pem`。
- `WECHAT_MCH_SERIAL_NO` 是与该私钥配套的商户 API 证书序列号。
- `WECHAT_PLATFORM_CERT_PATH` 指向用于验证微信支付回调签名的微信支付平台证书公钥或平台公钥 PEM；不能指向商户证书。
- `.env`、AppSecret、API v3 密钥和私钥不能提交到 Git，也不能出现在截图、前端或日志中。

修改 `.env` 后必须重启应用服务：

```bash
sudo systemctl restart panxiang.service
sudo systemctl status panxiang.service --no-pager
```

### 4. 微信支付回调 URL

当前代码创建 JSAPI 预支付单时，会把下面地址作为每笔订单的 `notify_url` 发送给微信支付：

```text
https://api.reloadb.com/api/wechat/notify
```

因此它主要在服务器 `.env` 中配置，并不是依赖一个“全局回调地址”输入框。如果商户后台某个产品配置页也要求填写通知地址，使用同一完整 URL。

该地址必须：

- 公网可访问并具有有效 HTTPS 证书；
- 不携带查询参数；
- 不要求 Cookie、网页登录或 IP 白名单；
- 保留原始请求体和微信支付签名头给 Node 服务验签；
- 在 5 秒内返回 2xx，否则微信支付会重试。

Nginx 必须把 `api.reloadb.com` 的该路径反向代理到本机 Node 服务。不要把它和 ReloadN 的 `/api/provider/webhook` 混用。

## 四、当前代码对应关系

| 用户动作 | 当前接口/行为 | 外部平台依赖 |
| --- | --- | --- |
| 从服务号打开首页 | `GET /` | 自定义菜单 URL |
| 检查微信身份 | `GET /api/wechat/session` | 已有微信会话 Cookie |
| 获取 OpenID | `GET /api/wechat/oauth/start` → `/api/wechat/oauth/callback` | 网页授权域名、服务号 AppID/AppSecret |
| 创建本地订单 | `POST /api/orders` | 套餐已上架、手机号有效 |
| 获取 JSAPI 参数 | `POST /api/wechat/prepay` | AppID 与 MCHID 已关联、证书/API v3 配置正确 |
| 拉起微信收银台 | `WeixinJSBridge.getBrandWCPayRequest` | JSAPI 支付开通、授权目录匹配 |
| 接收支付结果 | `POST /api/wechat/notify` | 公网回调 URL、平台证书/公钥、API v3 密钥 |
| 提交真实充值 | 支付成功后服务器异步处理 | ReloadN API |
| 接收充值终态 | `POST /api/provider/webhook` | ReloadN Webhook URL 和 Secret |

## 五、上线前验收清单

### A. 域名、HTTPS 和进程

- [ ] `https://reloadb.com/` 在手机浏览器中打开无证书警告。
- [ ] `https://api.reloadb.com/api/health` 返回 HTTP 200。
- [ ] HTTP 自动跳转 HTTPS，跳转后域名和路径正确。
- [ ] 80/443 对公网开放；Node 3000 端口不对公网开放。
- [ ] Nginx 与 `panxiang.service` 均为 running。
- [ ] 网页授权/JS 安全域名校验文件可以通过精确 URL 返回 HTTP 200。

快速只读检查：

```bash
curl -fsSI https://reloadb.com/
curl -fsS https://api.reloadb.com/api/health
sudo systemctl status nginx panxiang.service --no-pager
```

### B. 服务号授权

- [ ] 服务号已认证，菜单已发布且 URL 是 `https://reloadb.com/`。
- [ ] `WECHAT_APPID` 与当前服务号 AppID 一致。
- [ ] 网页授权域名是 `reloadb.com`，没有协议和路径。
- [ ] 从服务号菜单打开后完成静默授权，不出现循环跳转。
- [ ] 授权回调回到原站内页面，不会跳到站外 URL。
- [ ] 在微信外打开时不会误导用户完成支付，并有“请在微信内打开”的明确提示。

### C. 商户号和 JSAPI

- [ ] 商户平台显示服务号 AppID 已关联成功；公众平台侧也已确认。
- [ ] JSAPI 支付产品已开通。
- [ ] JSAPI 支付授权目录是 `https://reloadb.com/`，不是 HTTP，也不是旧 `/pay/` 目录。
- [ ] `.env` 中 MCHID、证书序列号、私钥文件和 API v3 密钥互相配套。
- [ ] 私钥权限收紧，且所有密钥文件均未进入 Git。

可在服务器检查路径和权限，但不要输出密钥内容：

```bash
sudo test -r /opt/panxiang-recharge/keys/apiclient_key.pem
sudo test -r /opt/panxiang-recharge/keys/wechatpay_platform_public_key.pem
sudo stat -c '%a %U:%G %n' /opt/panxiang-recharge/keys/*.pem
```

### D. 一笔真实低金额端到端验收

使用普通关注者微信、真实印尼号码和当前最低金额的已上架 SKU：

1. [ ] 从服务号菜单进入，选择套餐并输入号码。
2. [ ] 点击支付只生成一笔本地订单，连续点击不会生成多笔有效支付/充值。
3. [ ] 主动取消一次支付：订单保持未支付，ReloadN 不应收到充值订单。
4. [ ] 再完成一笔支付：微信收银台显示的商户、商品描述和金额正确。
5. [ ] 支付完成后页面先显示“支付成功/充值处理中”，不能在供应商未确认时提前显示“充值成功”。
6. [ ] Nginx 日志出现 `POST /api/wechat/notify` 且返回 2xx。
7. [ ] 微信支付相同回调重试时不会重复向 ReloadN 下单。
8. [ ] ReloadN 只收到一笔对应订单，金额/SKU/号码正确。
9. [ ] Nginx 日志出现 `POST /api/provider/webhook` 且返回 2xx。
10. [ ] 用户订单最终更新为充值成功；失败订单进入明确的失败/退款或人工处理状态。

只查看回调状态，不输出请求体中的敏感数据：

```bash
sudo grep -E 'POST /api/(wechat/notify|provider/webhook)' /var/log/nginx/access.log | tail -n 30
sudo journalctl -u panxiang.service -n 200 --no-pager
```

### E. 订单查询和异常场景

- [ ] 支付后刷新页面、返回重进或从“我的订单”进入，仍可看到该订单。
- [ ] 用户只能查看自己的订单；更换微信账号不能读取他人订单。
- [ ] 手机号与所选运营商不匹配时阻止下单，并给出清楚提示。
- [ ] 下架/停售 SKU 在前台不可继续购买。
- [ ] 价格为 0、汇率过期或供应商同步异常时阻止支付。
- [ ] 微信支付成功但 ReloadN 暂时超时时，不重复扣款，并进入可重试/人工处理状态。
- [ ] 应用重启后订单仍存在，已处理的支付和供应商回调仍保持幂等。
- [ ] 回调签名错误、金额不一致、AppID/MCHID 不一致均被拒绝并留下可定位日志。

## 六、发布阻断项与容易混淆的点

以下任一项未满足时，不应正式对外放量：

- AppID 与 MCHID 未完成双向关联；
- JSAPI 支付授权目录仍是 HTTP 或错误路径；
- 微信支付回调不是稳定的公网 HTTPS 地址，或回调仍返回 4xx/5xx；
- 支付成功后可能重复调用供应商；
- 用户看到“支付成功”就被误导为“充值成功”；
- 管理后台或公共接口泄露供应商密钥、微信密钥、买入价等敏感信息。

三个“域名”用途不同：

```text
网页授权域名        reloadb.com                公众平台，用于取得 OpenID
JS 接口安全域名      reloadb.com                公众平台，用于 JS-SDK 能力
JSAPI 支付授权目录   https://reloadb.com/       商户平台，用于校验支付调用页面
```

两个“回调”用途也不同：

```text
微信支付结果   https://api.reloadb.com/api/wechat/notify
ReloadN 结果   https://api.reloadb.com/api/provider/webhook
```

## 七、官方参考

- [微信支付：开发接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4015423216)
- [微信支付：配置 JSAPI 支付授权目录](https://pay.wechatpay.cn/doc/v3/merchant/4013287088)
- [微信支付：JSAPI/小程序下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791856)
- [微信支付：开发必要参数说明](https://pay.wechatpay.cn/doc/v3/merchant/4013070756)
- [微信支付：管理商户号绑定的 AppID 账号](https://pay.wechatpay.cn/doc/v3/merchant/4013289251)
- [微信支付：回调通知注意事项](https://pay.wechatpay.cn/doc/v3/merchant/4012075420)
- [微信支付：支付成功回调通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791861)
- [微信公众平台：网页授权](https://developers.weixin.qq.com/doc/offiaccount/OA_Web_Apps/Wechat_webpage_authorization.html)
- [微信公众平台：JS-SDK](https://developers.weixin.qq.com/doc/offiaccount/OA_Web_Apps/JS-SDK.html)
