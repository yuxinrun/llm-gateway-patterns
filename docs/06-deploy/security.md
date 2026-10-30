---
title: 安全加固与输入防护
description: 从密钥泄露、SSRF、提示注入到输出泄露，给 LLM 网关建立可落地的安全边界。
---

# 安全加固与输入防护

网关是流量的必经之路，也是攻击者最有价值的目标：拿到一个 Key 就能免费调用模型，控制一个上游地址就能读取内网，往 prompt 里塞一段话就可能让 Agent 执行危险操作。

安全不是加一个 WAF 就结束，而是**在每一个数据入口和出口都设一道便宜的检查**。

## 先说结论

- **Key 只存哈希**，用前缀索引 + 常量时间比较，支持轮换与细粒度作用域。
- **绝不允许用户指定上游地址**，SSRF 是网关最危险的设计缺陷之一。
- **输入校验放在转发前**：大小、结构、角色、内容类型，越早拒绝越便宜。
- **提示注入无法靠规则根治**，要靠权限最小化 + 分层检测 + 人工审核高风险工具。
- **输出也要检查**：模型可能复述密钥、PII 或工具返回的敏感字段。
- **错误信息不能泄露内部细节**，但要对用户可操作。

## 威胁模型

| 威胁 | 入口 | 影响 | 主要防线 |
| --- | --- | --- | --- |
| 凭证泄露 | 客户端、日志、仓库 | 被盗刷、数据泄露 | Key 哈希、轮换、异常检测 |
| 越权访问 | 请求参数 | 用未授权模型/租户数据 | 作用域、租户隔离 |
| 滥用 | 注册、免费额度 | 成本、容量 | 限流、预算、风控 |
| 提示注入 | 用户输入、工具结果 | 执行越权操作 | 权限最小化、检测、审批 |
| SSRF | 自定义 base_url | 读取内网、云元数据 | 地址白名单 |
| 数据外泄 | 输出、日志、缓存 | 泄露 PII/密钥 | 脱敏、缓存隔离、输出扫描 |
| 供应链 | 依赖、镜像 | 后门、RCE | 固定版本、扫描、非 root |
| 内部威胁 | 运维、后台 | 篡改配置、查看数据 | 审计、最小权限、双人复核 |

## 密钥管理

### 格式与存储

```text
lgw_live_<key_id>_<secret>
      │         │       └── 32 字节随机，只显示一次
      │         └── 公开索引，用于查库
      └── 环境标识
```

```python
import hashlib
import hmac
import secrets

PEPPER = load_secret("KEY_PEPPER")


def new_key() -> tuple[str, str, str]:
    key_id = secrets.token_hex(6)
    secret = secrets.token_urlsafe(32)
    digest = hmac.new(PEPPER, secret.encode(), hashlib.sha256).hexdigest()
    return f"lgw_live_{key_id}_{secret}", key_id, digest


def verify(provided: str, stored_digest: str) -> bool:
    digest = hmac.new(PEPPER, provided.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(digest, stored_digest)
```

为什么要 pepper：

- 数据库泄露时，攻击者无法直接离线爆破（还需要 pepper）。
- pepper 存在 KMS/环境变量里，与数据库分离。
- 轮换 pepper 需要重新计算所有哈希，所以通常只轮换 Key。

::: warning 不要用明文或可逆加密存 Key
「加密存储」听起来安全，但密钥一旦和数据库在同一环境，等于没加密。哈希 + pepper 是更简单也更可靠的方案。
:::

### 作用域

Key 不应该拥有租户的全部权限。给它作用域：

```json
{
  "key_id": "a1b2c3d4e5f6",
  "tenant_id": "t_1001",
  "scopes": ["chat:write", "models:read"],
  "models": ["chat-default", "chat-fast"],
  "features": ["support-bot"],
  "ip_allowlist": ["203.0.113.0/24"],
  "expires_at": "2026-12-31T00:00:00Z",
  "rate_limit": { "rpm": 60, "tpm": 100000 }
}
```

检查顺序：存在 → 未过期 → 未吊销 → IP → 作用域 → 模型白名单。任何一步失败都返回 401/403，且**不要在错误信息里透露哪一步失败**（对攻击者而言这是信息）。

### 轮换

```text
1. 创建新 Key（同作用域）
2. 客户端切换
3. 观察旧 Key 流量降为 0
4. 吊销旧 Key
```

支持「一个租户多个活跃 Key」，让轮换无需停机。设置最长有效期（如 90 天），到期前提醒。

## 传输安全

- 对外强制 HTTPS，HSTS。
- 网关到上游也用 TLS，不要因为「内网」就降级。
- 内部服务间建议 mTLS，至少用网络策略限制来源。
- 不要关闭证书校验（`verify=False`），这是最常见的「临时方案变永久」。

```python
client = httpx.AsyncClient(
    timeout=timeout,
    limits=limits,
    verify=True,          # 永远不要 False
    follow_redirects=False,
)
```

`follow_redirects=False` 很重要：上游如果返回 302 到内网地址，开启重定向就会变成 SSRF。

## SSRF 防护

如果网关允许用户配置 `base_url`（比如「接入你自己的模型端点」），必须做严格校验：

```python
import ipaddress
import socket
from urllib.parse import urlparse

BLOCKED_NETS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),   # 云元数据
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
]


def validate_upstream(url: str, allowlist: list[str]) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError("only https is allowed")
    host = parsed.hostname
    if not host:
        raise ValueError("missing host")
    if host not in allowlist:
        raise ValueError("host not in allowlist")

    infos = socket.getaddrinfo(host, parsed.port or 443, proto=socket.IPPROTO_TCP)
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if any(ip in net for net in BLOCKED_NETS):
            raise ValueError("resolved to private address")
    return url
```

要点：

- **先白名单，再解析**。白名单比黑名单可靠。
- **解析后检查 IP**，防止 DNS rebinding。
- **禁止重定向**，或在每一跳重新校验。
- **限制端口**，只允许 443。
- **解析和连接之间仍有 TOCTOU 窗口**，高安全场景要用固定 IP 或出网代理。

云环境的 `169.254.169.254` 是重点目标，能读到实例凭证。任何允许用户控制 URL 的功能都要默认屏蔽它。

## 输入校验

### 结构与大小

```python
MAX_BODY_BYTES = 10 * 1024 * 1024
MAX_MESSAGES = 200
MAX_TOOLS = 64


def validate_body(raw: bytes, body: dict) -> None:
    if len(raw) > MAX_BODY_BYTES:
        raise GatewayError(413, "body_too_large", "request body exceeds 10MB")
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise GatewayError(400, "invalid_messages", "messages must be a non-empty array")
    if len(messages) > MAX_MESSAGES:
        raise GatewayError(400, "too_many_messages", f"max {MAX_MESSAGES} messages")
    if len(body.get("tools") or []) > MAX_TOOLS:
        raise GatewayError(400, "too_many_tools", f"max {MAX_TOOLS} tools")
    for m in messages:
        if m.get("role") not in {"system", "user", "assistant", "tool"}:
            raise GatewayError(400, "invalid_role", f"unknown role {m.get('role')!r}")
```

### 内容检查

提示注入检测是概率性的，但便宜的规则能挡住大量低质量攻击：

```python
SUSPICIOUS = [
    r"ignore (all )?(previous|above) instructions",
    r"disregard (the )?(system|previous)",
    r"忽略(之前|以上|前面)(的)?(所有)?(指令|规则)",
    r"你现在是",
    r"reveal (your )?(system )?prompt",
    r"<\|im_start\|>",
]


def scan_text(text: str) -> int:
    score = 0
    lowered = text.lower()
    for pattern in SUSPICIOUS:
        if re.search(pattern, lowered):
            score += 1
    if len(re.findall(r"[A-Za-z0-9+/]{200,}={0,2}", text)) > 0:
        score += 1   # 长 base64，可能是隐藏指令
    return score
```

命中不等于拦截。建议分级：

| 分数 | 动作 |
| --- | --- |
| 0 | 放行 |
| 1–2 | 记录 + 打标 |
| ≥ 3 | 拦截或转人工 |
| 工具结果命中 | 标记该次工具调用，限制后续高风险工具 |

**不要把注入检测当成安全边界**。它只是提高攻击成本，真正的边界是工具权限：一个只能读公开数据的工具，被注入了也做不了什么。

## 输出防护

模型可能：

- 复述 system prompt。
- 输出工具返回的密钥、连接串。
- 生成看起来像真实身份证/银行卡的字符串。
- 把用户的隐私数据回显给另一个人（多租户场景）。

流式输出下，检测要在转发前做，但**不能等整段生成完**——那样就失去了流式的意义。折中方案：

- 对每个 chunk 做增量扫描，命中后立即中断并发送错误事件。
- 对高风险租户关闭流式，改为完整生成后检测。
- 对「密钥格式」这类确定性高的模式做逐块检测；对语义类风险做抽样或异步审计。

```python
SECRET_PATTERNS = [
    r"sk-[A-Za-z0-9]{20,}",
    r"lgw_live_[a-f0-9]{12}_[A-Za-z0-9_-]{20,}",
    r"AKIA[0-9A-Z]{16}",
    r"-----BEGIN (RSA |EC )?PRIVATE KEY-----",
]


def find_secrets(text: str) -> list[str]:
    hits = []
    for p in SECRET_PATTERNS:
        hits.extend(re.findall(p, text))
    return hits
```

命中后不要只记日志——日志本身也会保存密钥。记录**模式类型与位置**，不记录原文。

## 日志与错误

| 内容 | 是否记录 |
| --- | --- |
| API Key | ❌ 只记 `key_id` |
| Authorization 头 | ❌ 删除 |
| 完整 prompt | 默认 ❌，L1 截断/脱敏 |
| 工具参数 | 默认 ❌，只记大小与哈希 |
| 上游响应体 | 仅错误摘要，且脱敏 |
| 用户 PII | 按合规要求，默认不落 |

错误信息的分寸：

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "model_not_found",
    "message": "model 'foo' is not available for this key",
    "request_id": "req_9f2c1a"
  }
}
```

不要返回上游的原始错误体（可能包含内部域名、账号 ID、堆栈），也不要返回「Key 的前 8 位正确但后 8 位错误」这类信息。

## 多租户安全

回顾[多租户](../04-scenarios/multi-tenant.md)的六个隔离面，安全视角下重点检查：

- 缓存 Key 是否含租户。
- 对象存储路径是否按租户隔离，签名 URL 是否可越权。
- 日志查询后台是否强制租户过滤。
- 导出功能是否只能导出本租户数据。
- 管理 API 是否有独立的鉴权（不能和普通 Key 共用）。

一个常见的越权：`GET /v1/files/{id}` 只校验了登录，没有校验文件属于当前租户。ID 可枚举时就是批量泄露。

## 供应链与运行时

| 项 | 做法 |
| --- | --- |
| 依赖 | 锁定版本，使用 lockfile，定期扫描 CVE |
| 镜像 | 固定 digest，最小基础镜像，非 root |
| 文件系统 | 只读根文件系统，临时目录单独挂载 |
| 权限 | 去掉多余 capability，禁止提权 |
| 网络 | 出网白名单，限制可访问的上游 |
| 密钥 | 运行时注入，不烘焙进镜像 |
| 构建 | 可复现构建，校验产物 |

```yaml
security_opt:
  - no-new-privileges:true
read_only: true
tmpfs:
  - /tmp
cap_drop:
  - ALL
```

## 滥用与风控

- **注册即送额度**是最容易被薅的入口，加手机/企业验证。
- **异常检测**：同一 IP 多账号、短时间大量新 Key、请求模式高度重复。
- **黑名单**：泄露的 Key、恶意 IP、已知攻击特征。
- **人工审核**：高风险模型（如代码执行）或高额度申请。
- **预算硬上限**：任何租户都不能无限花。

## 事件响应

1. **确认**：是否真的泄露/被滥用，影响哪些租户。
2. **止血**：吊销 Key、封禁 IP、下线受影响功能。
3. **评估**：调取审计日志，确定时间范围与数据范围。
4. **通知**：按合规要求通知受影响方。
5. **修复**：补上导致事件的控制。
6. **复盘**：不追责个人，追责流程。

提前准备好「吊销一个租户全部 Key」的脚本，事件发生时不要现写。

## 反模式

| 反模式 | 后果 |
| --- | --- |
| 明文存 Key | 库泄露即全量泄露 |
| 用户可配任意 `base_url` | SSRF 读内网/云元数据 |
| `verify=False` | 中间人攻击 |
| 开启重定向 | 302 绕过白名单 |
| 错误信息含上游原文 | 泄露内部信息 |
| 日志记录完整 prompt | 密钥/PII 二次泄露 |
| 只靠注入正则 | 被改写绕过，产生虚假安全感 |
| 管理 API 与业务 Key 共用鉴权 | 越权改配置 |
| 缓存 Key 不含租户 | 跨租户数据泄露 |
| 容器 root + 可写文件系统 | 逃逸后持久化 |

## Checklist

- [ ] Key 哈希存储 + pepper + 常量时间比较
- [ ] Key 有作用域、模型白名单、IP 限制、有效期
- [ ] 支持多 Key 并存与平滑轮换
- [ ] 全链路 TLS，禁用证书校验跳过
- [ ] 用户可控 URL 有白名单 + 私网 IP 检查 + 禁止重定向
- [ ] 请求体大小、消息数、工具数有上限
- [ ] 注入检测分级处理，不作为唯一防线
- [ ] 输出侧扫描密钥/PII，流式采用增量策略
- [ ] 日志不记录 Key、完整 prompt、工具参数原文
- [ ] 错误信息不泄露上游与内部细节
- [ ] 多租户的缓存、存储、日志、导出均隔离
- [ ] 依赖与镜像固定版本并扫描
- [ ] 容器非 root、只读文件系统、最小权限
- [ ] 有吊销与封禁的应急预案

## 下一篇

安全边界就绪后，最后一块是变更管理：[模型版本灰度与金丝雀](./canary.md)。
