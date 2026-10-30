---
title: Security Hardening and Input Protection
description: From key leakage, SSRF and prompt injection to output leakage, establish practical security boundaries for an LLM gateway.
---

# Security Hardening and Input Protection

The gateway sits on the path of every request, which also makes it the most valuable target for an attacker: one stolen key means free model calls, control of an upstream URL means reads into your private network, and one injected paragraph can make an agent perform a dangerous action.

Security does not end with putting a WAF in front. It means **placing a cheap check at every data entry and exit point**.

## The short version

- **Store only key hashes**, with a prefix index and constant-time comparison, and support rotation and fine-grained scopes.
- **Never let users specify the upstream URL.** SSRF is one of the most dangerous design flaws in a gateway.
- **Validate input before forwarding**: size, structure, roles, content types. Rejecting early is cheaper.
- **Prompt injection cannot be solved by rules alone.** Use least privilege, layered detection, and human review for high-risk tools.
- **Check output too**: a model may echo secrets, PII, or sensitive fields returned by tools.
- **Error messages must not leak internal details**, yet must be actionable for the user.

## Threat model

| Threat | Entry point | Impact | Primary defense |
| --- | --- | --- | --- |
| Credential leakage | Client, logs, repository | Fraudulent usage, data breach | Key hashing, rotation, anomaly detection |
| Unauthorized access | Request parameters | Use of unpermitted models/tenant data | Scopes, tenant isolation |
| Abuse | Signup, free tier | Cost, capacity | Rate limits, budgets, risk controls |
| Prompt injection | User input, tool results | Unauthorized actions | Least privilege, detection, approval |
| SSRF | Custom `base_url` | Reads internal network, cloud metadata | Address allowlist |
| Data exfiltration | Output, logs, caches | PII/secret leakage | Redaction, cache isolation, output scanning |
| Supply chain | Dependencies, images | Backdoors, RCE | Pinned versions, scanning, non-root |
| Insider threat | Operations, admin console | Config tampering, data viewing | Auditing, least privilege, dual approval |

## Secret management

### Format and storage

```text
lgw_live_<key_id>_<secret>
      |         |       +-- 32 random bytes, shown only once
      |         +-- public index, used for lookups
      +-- environment identifier
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

Why a pepper:

- If the database leaks, an attacker cannot brute-force offline without also having the pepper.
- The pepper lives in a KMS or environment variable, separate from the database.
- Rotating the pepper requires recomputing every hash, so in practice you rotate keys instead.

::: warning Never store keys in plaintext or reversibly encrypted form
"Encrypted at rest" sounds safe, but if the encryption key lives in the same environment as the database, it is effectively unencrypted. Hashing plus a pepper is simpler and more reliable.
:::

### Scopes

A key should not carry all of a tenant's permissions. Give it scopes:

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

Check order: exists, not expired, not revoked, IP, scopes, model allowlist. Any failure returns 401/403, and **do not reveal which step failed in the error message** (to an attacker that is information).

### Rotation

```text
1. Create a new key (same scopes)
2. Switch the client over
3. Watch old-key traffic drop to zero
4. Revoke the old key
```

Support "multiple active keys per tenant" so rotation needs no downtime. Set a maximum lifetime (say 90 days) and remind before it expires.

## Transport security

- Enforce HTTPS externally, with HSTS.
- Use TLS between the gateway and upstreams too; do not downgrade because it is "internal".
- Prefer mTLS between internal services, or at minimum restrict sources with network policies.
- Never disable certificate verification (`verify=False`). This is the most common "temporary workaround that became permanent".

```python
client = httpx.AsyncClient(
    timeout=timeout,
    limits=limits,
    verify=True,          # never False
    follow_redirects=False,
)
```

`follow_redirects=False` matters: if an upstream returns a 302 to an internal address, following redirects turns into SSRF.

## SSRF protection

If the gateway lets users configure `base_url` (for example "connect your own model endpoint"), validation must be strict:

```python
import ipaddress
import socket
from urllib.parse import urlparse

BLOCKED_NETS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),   # cloud metadata
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

Key points:

- **Allowlist first, then resolve.** An allowlist is more reliable than a blocklist.
- **Check the IP after resolution** to defeat DNS rebinding.
- **Forbid redirects**, or revalidate on every hop.
- **Restrict ports** to 443 only.
- **A TOCTOU window remains between resolution and connection**; high-security environments should use fixed IPs or an egress proxy.

In cloud environments, `169.254.169.254` is a prime target: it can expose instance credentials. Any feature that lets users control a URL must block it by default.

## Input validation

### Structure and size

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

### Content checks

Prompt-injection detection is probabilistic, but cheap rules block a large amount of low-effort attacks:

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
        score += 1   # long base64, possibly hidden instructions
    return score
```

A hit does not mean blocking. Grade the response:

| Score | Action |
| --- | --- |
| 0 | Allow |
| 1-2 | Log + tag |
| >= 3 | Block or route to human review |
| Tool result hit | Flag the tool call and restrict subsequent high-risk tools |

**Do not treat injection detection as a security boundary.** It only raises the cost of attack. The real boundary is tool permissions: a tool that can only read public data cannot do much even when injected.

## Output protection

The model may:

- Repeat the system prompt.
- Emit secrets or connection strings returned by tools.
- Generate strings that look like real ID numbers or card numbers.
- Echo one user's private data back to someone else (in multi-tenant setups).

With streaming output, detection must happen before forwarding, but **you cannot wait for the entire generation** or streaming loses its purpose. Compromise options:

- Scan increments of each chunk and abort immediately with an error event on a hit.
- Disable streaming for high-risk tenants and detect after full generation.
- Check deterministic patterns such as secret formats chunk by chunk; sample or audit semantic risks asynchronously.

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

On a hit, do not just log it: logs themselves store secrets. Record the **pattern type and position**, not the matched text.

## Logging and errors

| Content | Log it? |
| --- | --- |
| API key | No, log `key_id` only |
| Authorization header | No, strip it |
| Full prompt | No by default; truncate/redact at L1 |
| Tool arguments | No by default; log size and hash only |
| Upstream response body | Error summary only, redacted |
| User PII | Per compliance requirements; not stored by default |

Calibrating error messages:

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

Do not return the upstream's raw error body (it may contain internal hostnames, account IDs or stack traces), and do not return things like "the first 8 characters of your key are correct but the last 8 are wrong".

## Multi-tenant security

Recall the six isolation surfaces in [multi-tenancy](../04-scenarios/multi-tenant.md). From a security perspective, focus on:

- Do cache keys include the tenant?
- Are object storage paths isolated per tenant, and can signed URLs be used to cross tenants?
- Does the log query console enforce tenant filtering?
- Can export functions export only the current tenant's data?
- Does the admin API have its own authentication (it must not share auth with ordinary keys)?

A common authorization gap: `GET /v1/files/{id}` checks that the caller is logged in but not that the file belongs to their tenant. If IDs are enumerable, that is a bulk data leak.

## Supply chain and runtime

| Item | Practice |
| --- | --- |
| Dependencies | Pin versions, use a lockfile, scan for CVEs regularly |
| Images | Pin digests, minimal base images, non-root |
| Filesystem | Read-only root filesystem, mount temp directories separately |
| Permissions | Drop unnecessary capabilities, forbid privilege escalation |
| Network | Egress allowlist, restrict reachable upstreams |
| Secrets | Injected at runtime, never baked into images |
| Builds | Reproducible builds, verify artifacts |

```yaml
security_opt:
  - no-new-privileges:true
read_only: true
tmpfs:
  - /tmp
cap_drop:
  - ALL
```

## Abuse and risk controls

- **Free credits on signup** are the easiest thing to farm. Add phone or business verification.
- **Anomaly detection**: many accounts from one IP, a burst of new keys, highly repetitive request patterns.
- **Blocklists**: leaked keys, malicious IPs, known attack signatures.
- **Human review**: high-risk models (such as code execution) or high-quota requests.
- **Hard budget caps**: no tenant can spend without limit.

## Incident response

1. **Confirm**: was there a real leak or abuse, and which tenants are affected?
2. **Contain**: revoke keys, block IPs, take affected features offline.
3. **Assess**: pull audit logs and determine the time range and data scope.
4. **Notify**: notify affected parties as compliance requires.
5. **Fix**: add the control that would have prevented the incident.
6. **Review**: blame the process, not individuals.

Prepare a "revoke all keys for one tenant" script in advance. Do not write it during the incident.

## Anti-patterns

| Anti-pattern | Consequence |
| --- | --- |
| Storing keys in plaintext | A database leak is a total leak |
| Users can set any `base_url` | SSRF reads internal networks and cloud metadata |
| `verify=False` | Man-in-the-middle attacks |
| Redirects enabled | A 302 bypasses the allowlist |
| Error messages with raw upstream text | Leaks internal information |
| Logging full prompts | Secondary leakage of secrets/PII |
| Relying on injection regexes alone | Bypassed by rewording, creates false confidence |
| Admin API sharing auth with business keys | Unauthorized config changes |
| Cache keys without the tenant | Cross-tenant data leakage |
| Root containers with writable filesystems | Persistence after escape |

## Checklist

- [ ] Keys stored as hashes + pepper with constant-time comparison
- [ ] Keys have scopes, model allowlists, IP restrictions and expiry
- [ ] Multiple concurrent keys and smooth rotation are supported
- [ ] TLS end to end, no skipping certificate verification
- [ ] User-controlled URLs have an allowlist, private-IP checks and no redirects
- [ ] Request body size, message count and tool count are capped
- [ ] Injection detection is graded and never the only defense
- [ ] Output is scanned for secrets/PII, with an incremental strategy for streaming
- [ ] Logs exclude keys, full prompts and raw tool arguments
- [ ] Error messages leak neither upstream nor internal details
- [ ] Multi-tenant caches, storage, logs and exports are isolated
- [ ] Dependencies and images are pinned and scanned
- [ ] Containers are non-root, read-only and least-privilege
- [ ] A runbook exists for revoking and blocking

## Next

With the security boundary in place, the last piece is change management: [model version canaries](./canary.md).
