<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'

const { lang } = useData()
const isEn = computed(() => lang.value.startsWith('en'))
const prefix = computed(() => (isEn.value ? '/en' : ''))

const copy = computed(() =>
  isEn.value
    ? {
        eyebrow: 'The stack',
        title: 'Three layers, one call chain',
        lead: 'Model access, tool invocation and agent orchestration. Each site covers one layer; together they form a practical AI engineering stack.',
        current: 'You are here',
        gatewayLayer: 'Model gateway',
        gatewayDesc: 'Unified access · routing · quotas · tracing',
        mcpLayer: 'MCP tool layer',
        mcpDesc: 'Tool protocol · service governance · permissions',
        agentLayer: 'Agent orchestration',
        agentDesc: 'Planning · tool use · memory · evaluation',
        friendPrefix: '👉 Companion reading: ',
        and: ', '
      }
    : {
        eyebrow: '技术栈',
        title: '三层技术栈，一条调用链',
        lead: '模型接入、工具调用、Agent 编排。三个站点各讲一层，组合起来是一套可落地的 AI 工程栈。',
        current: '当前站点',
        gatewayLayer: '模型网关层',
        gatewayDesc: '统一接入 · 路由 · 配额 · 可观测',
        mcpLayer: 'MCP 工具层',
        mcpDesc: '工具协议 · 服务治理 · 权限边界',
        agentLayer: 'Agent 调度层',
        agentDesc: '规划 · 工具调用 · 记忆 · 评测',
        friendPrefix: '👉 配套阅读：',
        and: '、'
      }
)

const stack = computed(() => [
  {
    title: 'llm-gateway-patterns',
    layer: copy.value.gatewayLayer,
    desc: copy.value.gatewayDesc,
    href: withBase(`${prefix.value}/00-introduction/why-gateway.html`),
    current: true,
    external: false
  },
  {
    title: 'mcp-patterns',
    layer: copy.value.mcpLayer,
    desc: copy.value.mcpDesc,
    href: 'https://yuxinrun.github.io/mcp-patterns/',
    current: false,
    external: true
  },
  {
    title: 'better-agent',
    layer: copy.value.agentLayer,
    desc: copy.value.agentDesc,
    href: 'https://yuxinrun.github.io/better-agent/',
    current: false,
    external: true
  }
])
</script>

<template>
  <section class="home-block ecosystem">
    <p class="eyebrow">{{ copy.eyebrow }}</p>
    <h2>{{ copy.title }}</h2>
    <p class="lead">{{ copy.lead }}</p>

    <div class="stack">
      <template v-for="(item, index) in stack" :key="item.title">
        <a
          class="stack-card"
          :class="{ current: item.current }"
          :href="item.href"
          :target="item.external ? '_blank' : undefined"
          :rel="item.external ? 'noreferrer' : undefined"
        >
          <span v-if="item.current" class="badge">{{ copy.current }}</span>
          <span class="layer">{{ item.layer }}</span>
          <strong>{{ item.title }}</strong>
          <span class="desc">{{ item.desc }}</span>
        </a>
        <span v-if="index < stack.length - 1" class="arrow" aria-hidden="true">→</span>
      </template>
    </div>

    <p class="friend">
      {{ copy.friendPrefix
      }}<a href="https://yuxinrun.github.io/better-agent/" target="_blank" rel="noreferrer"
        >better-agent</a
      >{{ copy.and
      }}<a href="https://yuxinrun.github.io/mcp-patterns/" target="_blank" rel="noreferrer"
        >mcp-patterns</a
      >
    </p>
  </section>
</template>

<style scoped>
.home-block {
  margin: 0;
  scroll-margin-top: 80px;
}

.home-block .eyebrow {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
}

.home-block h2 {
  margin: 8px 0 10px;
  padding-top: 0;
  border-top: none;
  font-size: 28px;
  line-height: 1.3;
  letter-spacing: -0.02em;
  color: var(--vp-c-text-1);
}

.home-block .lead {
  margin: 0;
  max-width: 720px;
  font-size: 15px;
  line-height: 1.7;
  color: var(--vp-c-text-2);
}

.stack {
  display: flex;
  align-items: stretch;
  gap: 10px;
  margin-top: 28px;
}

.stack-card {
  position: relative;
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  color: inherit;
  text-decoration: none;
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease;
}

.stack-card:hover {
  border-color: var(--vp-c-brand-1);
}

.stack-card.current {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.badge {
  position: absolute;
  top: 14px;
  right: 14px;
  padding: 2px 8px;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-bg);
}

.layer {
  padding-right: 72px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

.stack-card strong {
  font-size: 16px;
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.desc {
  font-size: 13px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.arrow {
  align-self: center;
  font-size: 18px;
  color: var(--vp-c-text-3);
}

.home-block .friend {
  margin: 18px 0 0;
  font-size: 14px;
  color: var(--vp-c-text-2);
}

.home-block .friend a {
  font-weight: 600;
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.home-block .friend a:hover {
  text-decoration: underline;
}

@media (max-width: 768px) {
  .home-block h2 {
    font-size: 24px;
  }

  .stack {
    flex-direction: column;
  }

  .arrow {
    transform: rotate(90deg);
    margin: -2px auto;
  }
}
</style>
