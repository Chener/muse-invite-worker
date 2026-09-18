# KV Schema — muse-invite-v2

Namespace 建议名：**`muse-invite-v2`**
（deploy.sh 会按此名自动查找，不存在则创建；Worker 绑定名固定为 `KV`。）

## Keys

### `code:<CODE>` — 每个邀请码的众包动态状态（永久，无 TTL）

```jsonc
{
  "remaining": 12,           // int | null，码主自报剩余次数（null = 未知）
  "votes_works": 5,          // int，「还能用」票数
  "votes_dead": 1,           // int，「已失效」票数
  "owner_key_hash": "9f2a…", // string | null，sha256(owner_key) 十六进制；null = 未认领
  "claimed_at": "2026-09-19T…Z", // string | null，认领时间（ISO8601）
  "updated_at": "2026-09-19T…Z"  // string | null，最后变更时间（ISO8601）
}
```

### `iplimit:vote:<IP>:<CODE>` — 投票限流标记

- value：`"1"`
- `expirationTtl: 86400`（24 小时后自动消失，无需 cron）
- 语义：同一 IP 24 小时内对同一邀请码只能投一次（`POST /api/vote` 命中则返回 429 `already_voted`）。

### `iplimit:claim:<IP>` — 认领限流计数

- value：整数（字符串形式），每次认领 +1
- `expirationTtl: 86400`
- 语义：同一 IP 24 小时内最多认领 5 个码（`POST /api/claim` 超限返回 429 `claim_rate_limited`）。

## 设计说明

1. **目录字段的唯一来源是 `muse-invite` 仓库的 `data/codes.json`。**
   Worker 按 5 分钟内存缓存拉取该文件，再与 KV 动态字段合并后返回；
   KV 里**不存** code / invite_url / publisher 等静态目录字段，避免双写不一致。
   新增邀请码只需更新 `data/codes.json`，KV 状态会懒创建（`blankState()`）。

2. **owner_key 永不落盘原文。**
   认领时生成 256-bit 随机十六进制串，只把它的 SHA-256 存进 `owner_key_hash`，
   原文仅在认领响应里返回一次。校验用常量时间比较（`safeEqual`）。
   丢失后不可找回：站主需在 KV 后台手动删除该码的 `owner_key_hash`，
   码主重新认领即可。

3. **IP 取 `CF-Connecting-IP`**（Cloudflare 边缘真实客户端 IP），
   兜底取 `X-Forwarded-For` 首段。NAT / 代理后多用户共享配额是已知折中；
   如刷票升级，后续可在前端加 Cloudflare Turnstile 再放行（V2 暂不引入）。

4. **码主更新（`POST /api/owner-update`）不做 IP 限流**，
   凭 256-bit owner_key 鉴权，key 空间不可猜测；`remaining` 限整数 0–100000。

5. 手工运维示例（wrangler，需另行安装；日常不需要）：
   ```bash
   wrangler kv:key get --namespace-id=<NS_ID> "code:FOSIZX"
   wrangler kv:key delete --namespace-id=<NS_ID> "iplimit:vote:1.2.3.4:FOSIZX"
   ```
