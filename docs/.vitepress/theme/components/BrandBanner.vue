<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'

const { lang } = useData()
const isEn = computed(() => lang.value.startsWith('en'))

const copy = computed(() =>
  isEn.value
    ? {
        eyebrow: 'About the author',
        name: '鱼心快跑',
        slogan: '鱼心快跑，Bug 追不上',
        sloganAlt: 'Fast enough that bugs cannot catch up.',
        desc: 'Open-source AI engineering notes on model gateways, MCP and agents.'
      }
    : {
        eyebrow: '关于作者',
        name: '鱼心快跑',
        slogan: '鱼心快跑，Bug 追不上',
        sloganAlt: '',
        desc: '鱼心快跑出品的开源 AI 工程笔记：模型网关、MCP 与 Agent。'
      }
)
</script>

<template>
  <section class="home-block brand">
    <img
      class="brand-logo"
      :src="withBase('/yuxin-run.png')"
      alt="鱼心快跑"
      width="120"
      height="80"
      loading="lazy"
    />
    <div class="brand-copy">
      <p class="eyebrow">{{ copy.eyebrow }}</p>
      <p class="name">{{ copy.name }}</p>
      <p class="slogan">「{{ copy.slogan }}」</p>
      <p class="desc">{{ copy.desc }}</p>
      <p v-if="copy.sloganAlt" class="alt">{{ copy.sloganAlt }}</p>
    </div>
  </section>
</template>

<style scoped>
.brand {
  display: flex;
  align-items: center;
  gap: 24px;
  margin-top: 64px;
  padding: 24px 26px;
  border: 1px solid var(--vp-c-divider);
  border-left: 4px solid var(--vp-c-brand-1);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
}

.brand-logo {
  flex: 0 0 auto;
  width: 120px;
  height: auto;
  padding: 8px;
  border-radius: 12px;
  background: #fff;
}

.brand-copy {
  min-width: 0;
}

.eyebrow {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
}

.name {
  margin: 4px 0 0;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: -0.02em;
  color: var(--vp-c-text-1);
}

.slogan {
  margin: 4px 0 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

.desc {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--vp-c-text-2);
}

.alt {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--vp-c-text-3);
}

@media (max-width: 640px) {
  .brand {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
    padding: 20px;
  }

  .brand-logo {
    width: 96px;
  }
}
</style>
