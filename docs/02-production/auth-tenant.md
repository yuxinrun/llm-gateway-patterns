---
title: 鉴权隔离与多租户
description: 网关密钥设计、租户身份模型、权限校验、密钥轮换与数据隔离。
---

# 鉴权隔离与多租户

限流回答「你能用多少」，鉴权回答「你是谁、能用什么」。两者顺序不能反：**先认人，再限额**。

## 身份模型

推荐三层，够用且不复杂：

```text
Organization（企业 / 客户）
  └── Project（业务线 / 环境）
        └── API Key（服务 / 开发者）
```

| 层级 | 承载什么 | 示例 |
| --- | --- | --- |
| Organization | 合同、总预算、数据边界 | `acme` |
| Project | 环境、业务线、模型白名单 | `acme-prod-chat` |
| API Key | 调用凭证、细粒度配额 | `lgw_live_9f2c...` |

角色可以简单分为：

- `admin`：管理租户、密钥、配额；
- `developer`：调用模型、查看自己的用量；
- `viewer`：只读看板与账单。

::: warning 不要用「一个超级 Key」打天下
所有服务共用一把 Key，等于没有鉴权：无法限额、无法定位、无法单独吊销。Key 的粒度应该和「谁需要独立负责」对齐。
:::

## API Key 怎么设计

### 格式

```text
lgw_live_<key_id>_<secret>
       │         └─ 高熵随机串，只在创建时展示一次
       └─ 可公开的标识，用于快速查找
```

- 前缀 `lgw_live` 便于密钥扫描工具识别；
- `key_id` 用于数据库索引，避免全表扫描；
- `secret` 至少 256 位熵，用 `secrets.token_urlsafe(32)`；
- 测试环境用 `lgw_test` 前缀，防止误用生产密钥。

### 存储：只存哈希

```python
import hashlib
import hmac
import secrets

KEY_PREFIX = "lgw_live"

def issue_key() -> tuple[str, str, str]:
    key_id = secrets.token_hex(8)
    secret = secrets.token_urlsafe(32)
    plaintext = f"{KEY_PREFIX}_{key_id}_{secret}"
    return plaintext, key_id, hashlib.sha256(plaintext.encode()).hexdigest()

def verify_key(plaintext: str, stored_digest: str, pepper: str) -> bool:
    digest = hmac.new(pepper.encode(), plaintext.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(digest, stored_digest)
```

说明：

- API Key 是高熵随机值，不是用户密码，SHA-256 可接受；加 pepper（服务端密钥）可以防止数据库泄露后被离线比对。
- 比较必须用 `compare_digest`，避免时序侧信道。
- 明文只在创建时返回一次，之后不可找回，只能轮换。

### 校验流程

```python
from dataclasses import dataclass

@dataclass
class AuthContext:
    tenant_id: str
    project_id: str
    key_id: str
    scopes: set[str]
    allowed_models: list[str]
    expires_at: float | None

async def authenticate(authorization: str | None) -> AuthContext:
    if not authorization:
        raise GatewayError(401, "invalid_api_key", "Missing Authorization header.")

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise GatewayError(401, "invalid_api_key", "Expected `Authorization: Bearer <key>`.")

    key_id = token.split("_")[2] if token.count("_") >= 2 else ""
    record = await key_store.get_by_id(key_id)
    if record is None or not verify_key(token, record.digest, PEPPER):
        raise GatewayError(401, "invalid_api_key", "Invalid API key.")

    if record.revoked_at is not None:
        raise GatewayError(401, "invalid_api_key", "API key has been revoked.")
    if record.expires_at and record.expires_at < now():
        raise GatewayError(401, "invalid_api_key", "API key has expired.")

    return AuthContext(...)
```

生产优化：

- 校验结果缓存 30～60 秒（key_id → context），减少数据库压力；
- 吊销/改权限时通过 pub/sub 主动失效，或接受最长 60 秒的延迟；
- 对认证失败做限流，防止暴力枚举。

## 授权：认证之后还要授权

认证只证明「Key 有效」，授权决定「能做什么」：

| 检查 | 失败码 | 说明 |
| --- | --- | --- |
| 模型别名是否在白名单 | `insufficient_permissions` | 防止 Free 用户调用最贵的模型 |
| 路由标签是否允许 | `insufficient_permissions` | 例如 `cn` 区域、`vision` 能力 |
| 请求 `max_tokens` 是否超上限 | `invalid_request` | 防止单次请求成本失控 |
| 是否允许流式 | `insufficient_permissions` | 某些套餐只允许非流式 |
| 是否允许工具调用 | `insufficient_permissions` | 按套餐或场景开启 |

```python
def authorize(ctx: AuthContext, body: dict, tags: set[str]) -> None:
    alias = body.get("model")
    if not any(fnmatch(alias, pattern) for pattern in ctx.allowed_models):
        raise GatewayError(403, "insufficient_permissions", f"Model '{alias}' is not allowed for this key.")

    if not tags.issubset(ctx.allowed_tags):
        raise GatewayError(403, "insufficient_permissions", "Requested route tags are not allowed.")

    max_tokens = body.get("max_tokens")
    if isinstance(max_tokens, int) and max_tokens > ctx.max_output_tokens:
        raise GatewayError(400, "invalid_request", f"max_tokens exceeds limit ({ctx.max_output_tokens}).")
```

::: tip 权限用「允许列表」而不是「拒绝列表」
新模型上线时，默认不可用；显式加入白名单才开放。拒绝列表会随着新模型不断漏。
:::

## 租户隔离的六个面

多租户不是「数据库加个 tenant_id」就结束了。至少要检查：

| 面 | 隔离要求 |
| --- | --- |
| 缓存 | 键带租户命名空间；默认不跨租户共享 |
| 日志 | 每条日志带 `tenant_id`，查询与保留策略按租户 |
| Trace | Span 属性带租户，避免在共享看板泄露 |
| 配额 | 按租户独立计算，父级可覆盖 |
| 账单 | 可拆分到租户/项目/Key |
| 模型权限 | 白名单 + 路由标签，防止越权访问高价/敏感模型 |

### 隔离级别

| 级别 | 做法 | 成本 | 适合 |
| --- | --- | --- | --- |
| 逻辑隔离 | 共享网关与上游 Key，按租户打标 | 低 | 大多数 SaaS |
| 凭证隔离 | 每租户独立上游 Key/项目 | 中 | 企业客户、成本透明 |
| 部署隔离 | 独立网关实例/命名空间 | 高 | 强合规、超大客户 |
| 模型隔离 | 独立推理实例/专有容量 | 很高 | 金融、医疗等 |

::: warning 企业客户问「我们的数据会不会和别人混在一起」
先确认你能否回答：缓存键、日志、Trace、上游账号、备份里分别如何隔离。答不上来，就别承诺「完全隔离」。
:::

## 人类用户与服务账号分开

- **服务调用**：API Key，适合机器对机器；
- **人类用户**：OIDC / SSO 换 JWT，网关校验签名、issuer、audience、过期时间；
- **管理后台**：独立的管理面鉴权，不要用推理 Key 调管理 API。

JWT 校验要点：

- 从 JWKS 拉公钥并缓存，支持轮换；
- 校验 `iss`、`aud`、`exp`、`nbf`；
- 只信任签名过的 `tenant_id`，不要相信客户端自带的 `x-tenant-id` 头；
- 管理操作要求更高权限，并记录审计日志。

## 密钥生命周期

| 阶段 | 做法 |
| --- | --- |
| 创建 | 只在创建时展示明文，记录创建人、用途、过期时间 |
| 使用 | 仅通过 `Authorization` 头传递，禁止放 URL |
| 轮换 | 新旧 Key 并存一个窗口（如 7 天），观察旧 Key 流量归零后吊销 |
| 吊销 | 立即生效 + 缓存主动失效 |
| 审计 | 记录创建、轮换、吊销、权限变更 |

::: danger 密钥不要出现在这些地方
URL 查询参数、前端代码、日志、错误响应、Git 历史、CI 明文变量、截图。任何一个都可能导致全量泄露。
:::

## 审计日志

管理面与数据面都要留痕，至少包含：

```json
{
  "ts": "2026-10-30T12:00:00Z",
  "actor": "user_123",
  "action": "key.revoked",
  "tenant_id": "acme",
  "key_id": "9f2c1a9b",
  "ip": "203.0.113.10",
  "result": "success",
  "request_id": "req_..."
}
```

审计日志要**只追加、不可篡改**，保留期按合规要求配置。

## 反模式

::: danger 从请求头直接取租户
`x-tenant-id: acme` 谁都能伪造。租户身份必须来自已校验的 Key 或 JWT。
:::

::: danger 所有服务共用一把 Key
无法限额、无法定位、无法吊销。按服务/环境拆 Key，是最低成本的治理。
:::

::: danger 明文存 Key
数据库一泄露，所有租户的额度一起暴露。只存哈希，创建时展示一次。
:::

::: danger Key 永不过期
离职、泄露、遗留测试脚本，都会留下长期风险。设置过期时间与轮换制度。
:::

::: danger 管理员 Key 调推理
管理 Key 权限过大，一旦泄露损失不可控。管理面与数据面分离。
:::

## 检查清单

- [ ] Key 有可识别前缀与不可猜测的 secret
- [ ] 数据库只存哈希，比较使用常量时间
- [ ] 认证失败有限流与审计
- [ ] 模型、标签、max_tokens 都有授权检查
- [ ] 租户身份来自签名凭证，不信任客户端头
- [ ] 缓存、日志、Trace、配额、账单都带租户维度
- [ ] Key 支持过期、轮换、吊销与主动失效
- [ ] 管理面与数据面鉴权分离
- [ ] 审计日志不可篡改

下一篇：[重试、熔断、降级与兜底](./resilience.md)。
