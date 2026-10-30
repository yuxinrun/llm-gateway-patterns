<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'
import { chaptersEn, chaptersZh } from '../../data/chapters'

const { lang } = useData()
const isEn = computed(() => lang.value.startsWith('en'))
const chapters = computed(() => (isEn.value ? chaptersEn : chaptersZh))

const copy = computed(() =>
  isEn.value
    ? {
        eyebrow: 'Chapters',
        title: 'Read it chapter by chapter',
        lead: 'Every chapter stands on its own. If this is your first visit, go 00 → 01 → 02, then jump to whatever is hurting in production.',
        open: 'Open chapter',
        count: (n: number) => `${n} articles`
      }
    : {
        eyebrow: '章节目录',
        title: '按章节推进',
        lead: '每一章都可以独立查阅。第一次读，建议按 00 → 01 → 02 的顺序；之后哪里痛，就翻哪一章。',
        open: '进入章节',
        count: (n: number) => `${n} 篇`
      }
)

function href(link: string) {
  return withBase(`${link}.html`)
}
</script>

<template>
  <section class="home-block chapters">
    <p class="eyebrow">{{ copy.eyebrow }}</p>
    <h2>{{ copy.title }}</h2>
    <p class="lead">{{ copy.lead }}</p>

    <div class="chapter-grid">
      <a
        v-for="(chapter, index) in chapters"
        :key="chapter.id"
        class="chapter-card"
        :class="`c${index}`"
        :href="href(chapter.items[0].link)"
      >
        <div class="chapter-head">
          <span class="num">{{ chapter.num }}</span>
          <h3>{{ chapter.title }}</h3>
          <span class="count">{{ copy.count(chapter.items.length) }}</span>
        </div>
        <p class="blurb">{{ chapter.blurb }}</p>
        <ul>
          <li v-for="item in chapter.items" :key="item.link">{{ item.text }}</li>
        </ul>
        <span class="more">{{ copy.open }} →</span>
      </a>
    </div>
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

.chapter-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 28px;
}

.chapter-card {
  display: flex;
  flex-direction: column;
  padding: 18px 20px;
  border: 1px solid var(--vp-c-divider);
  border-left: 3px solid var(--chapter, var(--vp-c-brand-1));
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  color: inherit;
  text-decoration: none;
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease;
}

.chapter-card:hover {
  border-color: var(--chapter, var(--vp-c-brand-1));
  background: var(--vp-c-bg-alt);
}

.chapter-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.num {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  font-weight: 700;
  color: var(--chapter, var(--vp-c-brand-1));
}

.home-block h3 {
  margin: 0;
  font-size: 17px;
  line-height: 1.4;
  color: var(--vp-c-text-1);
}

.count {
  margin-left: auto;
  font-size: 12px;
  color: var(--vp-c-text-3);
}

.blurb {
  margin: 8px 0 10px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.home-block ul {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--vp-c-text-2);
}

.more {
  margin-top: 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--chapter, var(--vp-c-brand-1));
}

@media (max-width: 768px) {
  .home-block h2 {
    font-size: 24px;
  }

  .chapter-grid {
    grid-template-columns: 1fr;
  }
}
</style>
