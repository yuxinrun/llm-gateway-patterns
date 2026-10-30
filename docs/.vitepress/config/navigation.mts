import type { DefaultTheme } from 'vitepress'
import {
  chaptersEn,
  chaptersZh,
  companionEn,
  companionZh,
  type Chapter
} from '../data/chapters'

function buildSidebar(
  chapters: Chapter[],
  companions: { text: string; link: string }[],
  companionTitle: string,
  prefix = ''
): DefaultTheme.SidebarMulti {
  const sidebar: DefaultTheme.SidebarMulti = {}

  for (const current of chapters) {
    sidebar[`${prefix}/${current.id}/`] = [
      {
        text: `${current.num} · ${current.title}`,
        collapsed: false,
        items: current.items
      },
      ...chapters
        .filter((chapter) => chapter.id !== current.id)
        .map((chapter) => ({
          text: `${chapter.num} · ${chapter.title}`,
          collapsed: true,
          items: chapter.items
        })),
      {
        text: companionTitle,
        collapsed: true,
        items: companions
      }
    ]
  }

  return sidebar
}

export const zhSidebar = buildSidebar(chaptersZh, companionZh, '配套阅读')

export const enSidebar = buildSidebar(chaptersEn, companionEn, 'Companion reading', '/en')

export const zhNav: DefaultTheme.NavItem[] = [
  { text: '开篇', link: '/00-introduction/why-gateway' },
  { text: '基础 Demo', link: '/01-basics/minimal-python' },
  {
    text: '模式手册',
    items: [
      { text: '02 生产级工程模式', link: '/02-production/routing' },
      { text: '03 可观测体系', link: '/03-observability/logging-tracing' },
      { text: '04 实战场景', link: '/04-scenarios/multi-vendor-failover' },
      { text: '05 调试与性能', link: '/05-debugging/sse-issues' },
      { text: '06 部署与运维', link: '/06-deploy/docker-compose' },
      { text: '07 生态集成', link: '/07-ecosystem/litellm' }
    ]
  },
  { text: '配套项目', items: companionZh }
]

export const enNav: DefaultTheme.NavItem[] = [
  { text: 'Start', link: '/en/00-introduction/why-gateway' },
  { text: 'Demos', link: '/en/01-basics/minimal-python' },
  {
    text: 'Playbook',
    items: [
      { text: '02 Production Patterns', link: '/en/02-production/routing' },
      { text: '03 Observability', link: '/en/03-observability/logging-tracing' },
      { text: '04 In Practice', link: '/en/04-scenarios/multi-vendor-failover' },
      { text: '05 Debugging', link: '/en/05-debugging/sse-issues' },
      { text: '06 Deployment', link: '/en/06-deploy/docker-compose' },
      { text: '07 Ecosystem', link: '/en/07-ecosystem/litellm' }
    ]
  },
  { text: 'Companions', items: companionEn }
]
