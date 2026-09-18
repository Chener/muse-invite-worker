# muse-invite-worker

Cloudflare Worker + KV 后端，供 https://muse.chenerpath.com 邀请码聚合站 V2 使用：

- 访客投票「还能用 / 已失效」（IP 限流防刷）
- 码主认领（一次性返回 `owner_key`）与自助更新剩余次数

## 文件

| 文件 | 说明 |
|---|---|
| `worker.js` | Worker 主程序（ES Module）。路由见下；CORS 仅允许 `https://muse.chenerpath.com` |
| `KV_SCHEMA.md` | KV 设计：namespace 建议名 `muse-invite-v2`，key 结构与 TTL |
| `deploy.sh` | Mac 上一键部署脚本（幂等，可重跑）：读 token → 发现 account → 建/复用 KV → 上传 worker → 输出域名 |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/codes` | 全部码：目录字段（来自 `data/codes.json`）+ KV 众包字段合并 |
| POST | `/api/vote` | `{code, verdict:"works"\|"dead"}`；同一 IP 24h 内对同一码限投一次（429） |
| POST | `/api/claim` | `{code}`；首次认领返回 `owner_key`（只显示一次）；已认领返回 409 |
| POST | `/api/owner-update` | `{code, owner_key, remaining}`；凭 key 更新剩余次数（整数 0–100000） |

所有错误统一返回 JSON：`{"error": "<code>"}`（附 HTTP 状态码）。

## 部署

```bash
# 1. token 存到 $HOME/.config/muse-bot/cloudflare_token（0600，本仓库不含任何密钥）
# 2. 在本目录执行：
./deploy.sh
```

输出示例：

```
WORKER_URL=https://muse-invite-v2.<subdomain>.workers.dev
```

拿到域名后，把前端分支 `feat/worker-v2` 上 `assets/worker-v2.js` 中的
`WORKER_URL_PLACEHOLDER` 替换为该域名即可上线。

## 防刷与 owner_key 设计要点

- 投票限流：KV key `iplimit:vote:<IP>:<CODE>`，`expirationTtl=86400`，24h 窗口自动过期，无需 cron。
- 认领限流：`iplimit:claim:<IP>` 计数，24h 内同一 IP 最多认领 5 个码。
- `owner_key` 为 256-bit 随机串，KV 只存其 SHA-256 哈希，原文永不落盘；丢失不可找回（站主手动删 `owner_key_hash` 后可重新认领）。
- IP 取 `CF-Connecting-IP`。NAT 后多用户共享配额是已知折中，后续可加 Turnstile。

验收（token 到达后，总协调员真实 curl）：见 `deploy.sh` 末尾冒烟测试。
