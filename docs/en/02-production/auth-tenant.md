---
title: Auth Isolation and Multi-Tenancy
description: Gateway key design, the tenant identity model, permission checks, key rotation, and data isolation.
---

# Auth Isolation and Multi-Tenancy

Rate limiting answers "how much can you use"; auth answers "who are you and what can you use". The order matters: **identify first, limit second**.

## Identity model

Three levels are recommended: enough, and not complicated:

```text
Organization (company / customer)
  └── Project (business unit / environment)
        └── API Key (service / developer)
```

| Level | What it carries | Example |
| --- | --- | --- |
| Organization | Contract, total budget, data boundary | `acme` |
| Project | Environment, business unit, model allowlist | `acme-prod-chat` |
| API Key | Call credentials, fine-grained quota | `lgw_live_9f2c...` |

Roles can be kept simple:

- `admin`: manages tenants, keys, and quotas;
- `developer`: calls models and views their own usage;
- `viewer`: read-only dashboards and billing.

::: warning Do not run everything on one super key
Sharing one key across all services is the same as having no auth: you cannot limit it, trace it, or revoke it separately. Key granularity should match "who needs to be independently accountable".
:::

## How to design API keys

### Format

```text
lgw_live_<key_id>_<secret>
       │         └─ high-entropy random string, shown only once at creation
       └─ public identifier, used for fast lookup
```

- The `lgw_live` prefix lets secret scanners recognize the key;
- `key_id` indexes the database lookup so you avoid a full table scan;
- `secret` has at least 256 bits of entropy; use `secrets.token_urlsafe(32)`;
- Use a `lgw_test` prefix in test environments to prevent accidental production key use.

### Storage: hash only

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

Notes:

- An API key is a high-entropy random value, not a user password, so SHA-256 is acceptable; adding a pepper (a server-side secret) prevents offline comparison after a database leak.
- Always compare with `compare_digest` to avoid timing side channels.
- The plaintext is returned only once at creation; afterward it cannot be recovered, only rotated.

### Verification flow

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

Production optimizations:

- Cache verification results for 30–60 seconds (`key_id` → context) to reduce database load;
- Invalidate actively via pub/sub on revocation or permission changes, or accept up to 60 seconds of delay;
- Rate limit authentication failures to stop brute-force enumeration.

## Authorization: authentication is not the end

Authentication only proves "the key is valid"; authorization decides "what it may do":

| Check | Failure code | Notes |
| --- | --- | --- |
| Is the model alias on the allowlist | `insufficient_permissions` | Stops Free users from calling the most expensive models |
| Are the route tags allowed | `insufficient_permissions` | For example the `cn` region or the `vision` capability |
| Does `max_tokens` exceed the cap | `invalid_request` | Stops a single request from running away in cost |
| Is streaming allowed | `insufficient_permissions` | Some plans allow only non-streaming |
| Are tool calls allowed | `insufficient_permissions` | Enabled per plan or scenario |

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

::: tip Use allowlists, not denylists
A new model is unavailable by default; it opens only when explicitly added to the allowlist. A denylist leaks every time a new model ships.
:::

## Six faces of tenant isolation

Multi-tenancy is not finished when "the database has a tenant_id column". Check at least:

| Face | Isolation requirement |
| --- | --- |
| Cache | Keys carry a tenant namespace; no cross-tenant sharing by default |
| Logs | Every log line carries `tenant_id`; query and retention policies per tenant |
| Traces | Span attributes carry the tenant so shared dashboards do not leak |
| Quota | Computed per tenant, overridable by the parent |
| Billing | Splittable down to tenant/project/key |
| Model permissions | Allowlist plus route tags to prevent access to expensive or sensitive models |

### Isolation levels

| Level | Approach | Cost | Fits |
| --- | --- | --- | --- |
| Logical isolation | Shared gateway and upstream keys, tag by tenant | Low | Most SaaS |
| Credential isolation | Dedicated upstream key/project per tenant | Medium | Enterprise customers, cost transparency |
| Deployment isolation | Separate gateway instances/namespaces | High | Strong compliance, very large customers |
| Model isolation | Dedicated inference instances/capacity | Very high | Finance, healthcare, and similar |

::: warning Enterprise customers ask "will our data be mixed with others"
First confirm you can answer: how are cache keys, logs, traces, upstream accounts, and backups isolated? If you cannot answer, do not promise "full isolation".
:::

## Separate human users from service accounts

- **Service calls**: API keys, suited to machine-to-machine;
- **Human users**: OIDC / SSO exchanged for JWTs; the gateway verifies the signature, issuer, audience, and expiry;
- **Admin console**: separate control-plane auth; never call admin APIs with an inference key.

JWT verification points:

- Fetch public keys from JWKS and cache them, supporting rotation;
- Verify `iss`, `aud`, `exp`, and `nbf`;
- Trust only the signed `tenant_id`; never trust a client-supplied `x-tenant-id` header;
- Require higher privileges for admin actions and write audit logs.

## Key lifecycle

| Stage | Practice |
| --- | --- |
| Creation | Show the plaintext only at creation; record creator, purpose, and expiry |
| Use | Pass it only in the `Authorization` header; never in URLs |
| Rotation | Run old and new keys side by side for a window (for example 7 days), revoke the old one once its traffic hits zero |
| Revocation | Takes effect immediately, with active cache invalidation |
| Audit | Record creation, rotation, revocation, and permission changes |

::: danger Keys must never appear in these places
URL query parameters, frontend code, logs, error responses, git history, plaintext CI variables, screenshots. Any one of them can lead to a full leak.
:::

## Audit logs

Both the control plane and the data plane need a trail, containing at least:

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

Audit logs must be **append-only and tamper-evident**, with a retention period configured to your compliance requirements.

## Anti-patterns

::: danger Taking the tenant from a request header
Anyone can forge `x-tenant-id: acme`. Tenant identity must come from a verified key or JWT.
:::

::: danger Sharing one key across all services
You cannot limit it, trace it, or revoke it. Splitting keys per service/environment is the cheapest governance there is.
:::

::: danger Storing keys in plaintext
One database leak exposes every tenant's quota at once. Store only hashes and show the key once at creation.
:::

::: danger Keys that never expire
Departures, leaks, and leftover test scripts all leave long-term risk. Set expiry times and a rotation policy.
:::

::: danger Calling inference with an admin key
Admin keys are far too powerful; a leak means uncontrollable damage. Keep the control plane and data plane separate.
:::

## Checklist

- [ ] Keys have a recognizable prefix and an unguessable secret
- [ ] The database stores only hashes, compared in constant time
- [ ] Authentication failures are rate limited and audited
- [ ] Models, tags, and max_tokens all pass authorization checks
- [ ] Tenant identity comes from signed credentials, not client headers
- [ ] Cache, logs, traces, quota, and billing all carry the tenant dimension
- [ ] Keys support expiry, rotation, revocation, and active invalidation
- [ ] Control-plane and data-plane auth are separated
- [ ] Audit logs are tamper-evident

Next: [Retries, circuit breakers, degradation, and fallbacks](./resilience.md).
