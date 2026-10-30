---
title: 无状态横向扩展
description: 把限流、熔断、会话与配置从进程里拿出来，设计可安全扩缩容的网关。
---

# 无状态横向扩展

网关扩到 4 个副本后，往往会出现一批「只在多副本下才出现」的怪问题：限流额度变成 4 倍、熔断状态各说各话、缓存命中率暴跌、灰度配置改了一半。根因都是一个：**状态留在了进程内存里**。

## 先说结论

- **进程内只放可重建的缓存**，所有需要一致的状态放 Redis/Postgres。
- **限流必须全局**，否则实际额度 = 单副本额度 × 副本数。
- **熔断可以局部**，但要加随机抖动，避免所有副本同时探测。
- **不要依赖会话粘性**，粘性可以作为优化，不能作为正确性前提。
- **优雅关闭要等长流结束**，否则每次发版都会切断正在生成的回答。
- **扩缩容指标用并发/排队/TTFT**，不要只看 CPU。

## 哪些是状态

| 状态 | 现在在哪 | 应该在哪 | 可丢吗 |
| --- | --- | --- | --- |
| 限流计数 | 进程内存 ❌ | Redis | 短时间可丢 |
| 配额余额 | 进程内存 ❌ | Redis + DB | 不可丢 |
| 熔断状态 | 进程内存 ⚠️ | 本地可接受，或 Redis 共享 | 可丢 |
| 路由配置 | 启动时加载 ⚠️ | 配置中心 / DB + 热更新 | 不可丢 |
| 模型价格 | 代码常量 ⚠️ | DB / 配置 | 不可丢 |
| 响应缓存 | 本地 LRU ⚠️ | Redis（跨副本共享） | 可丢 |
| 前缀缓存 | 上游/实例 | 不在网关 | — |
| 会话粘性 | 无 | Redis（优化项） | 可丢 |
| 连接池 | 进程内 ✅ | 进程内（本来就该） | — |

「可丢」指丢失后只影响性能或短暂超额，不影响正确性。**限流计数可丢**，但丢了会让瞬间流量翻倍，所以仍建议持久化。

## 无状态化改造清单

1. 删除所有模块级的可变字典/列表（`_counters = {}`、`_state = []`）。
2. 把限流、配额、熔断、缓存改为 Redis 操作。
3. 配置从环境变量改为「启动加载 + 定期刷新 + 版本号」。
4. 文件上传、临时结果写到对象存储，不写本地磁盘。
5. 日志写 stdout，不写本地文件。
6. 会话数据放 Redis 或客户端 token，不放进程。
7. 定时任务加分布式锁，避免每个副本都跑一遍。

第 7 条经常被漏掉：4 个副本各自跑一次「月度账单聚合」，结果账单被算了 4 遍。

```python
async def run_once(key: str, ttl: int = 3600) -> bool:
    return bool(await redis.set(key, "1", nx=True, ex=ttl))
```

## 限流：全局一致

单副本令牌桶在 4 副本下等于 4 倍额度。必须用 Redis 原子操作（见[限流与配额](../02-production/rate-limit.md)）。

```python
async def allow(redis, tenant_id: str, cost: int) -> tuple[bool, int]:
    key = f"rl:{tenant_id}:{minute_bucket()}"
    remaining = await redis.eval(TOKEN_BUCKET_LUA, 1, key, cost, LIMIT, WINDOW)
    return remaining >= 0, max(remaining, 0)
```

代价是每个请求多一次 Redis 往返（约 0.5–2ms）。可以通过本地预聚合降低：

- 每个副本先在本地积累一个很小的配额（比如总配额的 1/副本数），用完再向 Redis 申请一批。
- 这样能把 Redis QPS 降低一个数量级，代价是额度分配不完全均匀，且有少量浪费。

这是典型的「精确性 vs 性能」权衡，按业务选择。

## 熔断：允许局部，但要抖动

熔断状态放本地是可以接受的：每个副本对上游的健康判断略有差异，反而能避免「全体同时熔断、全体同时恢复」的震荡。

关键是要加抖动：

```python
import random


def recovery_delay(base: float = 30.0) -> float:
    return base * random.uniform(0.8, 1.2)
```

如果要求严格一致（比如上游按 Key 计费，频繁试探会产生费用），就把状态放 Redis，但更新时用「最后写入获胜 + 版本号」，避免并发覆盖。

## 配置热更新

配置变更不应该要求重启所有副本。推荐结构：

```python
@dataclass(frozen=True)
class Config:
    version: str
    routes: dict
    quotas: dict
    prices: dict


class ConfigStore:
    def __init__(self, redis):
        self._redis = redis
        self._current = Config(version="0", routes={}, quotas={}, prices={})

    async def refresh(self) -> None:
        raw = await self._redis.get("config:current")
        if not raw:
            return
        data = json.loads(raw)
        if data["version"] != self._current.version:
            self._current = Config(**data)

    @property
    def current(self) -> Config:
        return self._current
```

配合后台任务每 5–10 秒刷新一次。注意：

- **配置要有版本号**，日志里记录使用的版本，便于排查「为什么两个副本行为不同」。
- **刷新失败要保留旧配置**，不要清空。
- **关键配置变更要审计**，谁在什么时候改了什么。

### 配置下发的顺序

先让新配置在所有副本可见，再切换流量。如果配置里包含「新增模型」，要确保上游 Key 和配额已经就绪，否则会出现短暂的 404/403。

## 扩缩容指标

CPU 是最差的扩容信号。异步网关在等上游时 CPU 很低，但并发已经满了。更合适的指标：

| 指标 | 为什么 |
| --- | --- |
| `gateway_inflight_requests` | 直接反映并发压力 |
| 连接池等待时间 | 说明请求在排队 |
| P95 TTFT | 用户感知的直接指标 |
| 事件循环延迟 | 反映单副本是否过载 |
| 每秒排队请求数 | 提前于延迟上升 |

K8s HPA 示例（基于自定义指标）：

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: llm-gateway
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: llm-gateway
  minReplicas: 3
  maxReplicas: 30
  metrics:
    - type: Pods
      pods:
        metric:
          name: gateway_inflight_requests
        target:
          type: AverageValue
          averageValue: "40"
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Percent
          value: 100
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 600
      policies:
        - type: Percent
          value: 25
          periodSeconds: 120
```

流式请求的特点是「扩容快、缩容要慢」：新副本能立刻分担流量，但缩容会切断正在进行的流。所以 `scaleDown` 的稳定窗口要长，且配合优雅关闭。

## 优雅关闭

```python
import asyncio
import signal

shutdown = asyncio.Event()


def handle_signal(*_):
    shutdown.set()


signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)
```

要点：

1. 收到 SIGTERM 后**停止接受新连接**（readiness 先失败）。
2. 等待进行中的请求完成，最多等 `grace_period`。
3. 超时后强制关闭，并记录未完成的请求数。
4. 关闭上游连接池、刷新日志、停止追踪导出。

```nginx
# Nginx 侧配合
proxy_next_upstream error timeout http_502;
```

K8s 的 `terminationGracePeriodSeconds` 要大于最长流式请求的时长，否则每次发版都会切断长回答。常见设置是 300 秒，但如果你允许 10 分钟的流，就要更大。

::: warning 滚动更新会短暂降低容量
默认的 rolling update 是「先起新、再停旧」，容量不会下降。但如果配置了 `maxSurge: 0`，就会先停后起，高峰期可能扛不住。发版要避开流量高峰。
:::

## 共享资源的瓶颈

扩副本时，瓶颈会转移：

| 资源 | 扩展后的问题 | 对策 |
| --- | --- | --- |
| Redis | 连接数、单键热点 | 连接池、分片、本地预聚合 |
| Postgres | 连接数、写入放大 | PgBouncer、批量写、读写分离 |
| 上游配额 | 副本多了但配额没变 | 全局配额、按副本分配 |
| 出口 IP | 供应商按 IP 限流 | NAT 网关、多出口 |
| DNS | 解析 QPS 上升 | 本地缓存、长 TTL |

上游配额是最容易被忽略的：网关从 2 副本扩到 20 副本，QPS 上去了，但供应商的 RPM 没变，结果是更多请求同时撞 429。

## 时钟与 ID

- 所有副本必须 NTP 同步，否则限流窗口、账单时间会对不上。
- 分布式 ID 不要用「时间戳 + 自增」，用 UUIDv7 或雪花算法。
- `trace_id` 用随机数，不要用机器信息拼接。

## 部署策略

| 策略 | 优点 | 缺点 |
| --- | --- | --- |
| Rolling | 简单、容量不降 | 新旧版本短暂共存 |
| Blue-Green | 切换干净、易回滚 | 需要双倍资源 |
| Canary | 风险最小 | 需要流量切分与对比 |

网关这类「无状态 + 有共享配置」的服务，推荐 **Rolling + 配置灰度**：代码用滚动发布，行为变更（模型、路由、价格）用配置灰度控制，两者解耦。

## 反模式

| 反模式 | 后果 |
| --- | --- |
| 限流计数在进程内 | 实际额度 = 副本数 × 配置值 |
| 定时任务无分布式锁 | 账单/报表重复计算 |
| 配置只在启动加载 | 改配置要重启全部副本 |
| 只用 CPU 扩容 | 等上游时 CPU 低，扩不出来 |
| 缩容窗口太短 | 正在生成的流被切断 |
| 会话粘性当正确性 | 副本重启后会话丢失 |
| 副本增多但上游配额不变 | 429 反而更多 |
| 时钟不同步 | 限流窗口与账单错位 |

## Checklist

- [ ] 进程内无可变共享状态
- [ ] 限流/配额在 Redis，多副本一致
- [ ] 熔断本地判断 + 随机抖动，或 Redis 共享
- [ ] 配置支持热更新、版本号与审计
- [ ] 定时任务有分布式锁
- [ ] 扩缩容基于并发/排队/TTFT，而非仅 CPU
- [ ] SIGTERM 优雅关闭，等待长流完成
- [ ] `terminationGracePeriodSeconds` 覆盖最长流
- [ ] 评估 Redis/Postgres/上游配额的扩展上限
- [ ] 所有节点 NTP 同步
- [ ] 发版避开流量高峰，保留回滚路径

## 下一篇

扩展之后，安全边界也要跟着扩大：[安全加固与输入防护](./security.md)。
