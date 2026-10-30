import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { enNav, enSidebar, zhNav, zhSidebar } from './config/navigation.mts'

const repo = 'https://github.com/yuxinrun/llm-gateway-patterns'
const base = '/llm-gateway-patterns/'

export default withMermaid(
  defineConfig({
    title: 'LLM Gateway Patterns',
    description:
      '大模型网关工程模式与实战手册：统一协议、多模型路由、缓存、限流、容错与成本治理。',
    base,
    lang: 'zh-CN',
    lastUpdated: true,
    vite: {
      optimizeDeps: {
        include: ['mermaid']
      }
    },
    head: [
      ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo.svg` }],
      ['meta', { name: 'theme-color', content: '#0f766e' }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:site_name', content: 'LLM Gateway Patterns' }]
    ],
    locales: {
      root: {
        label: '简体中文',
        lang: 'zh-CN',
        title: 'LLM Gateway Patterns',
        description: '大模型网关工程模式与实战手册'
      },
      en: {
        label: 'English',
        lang: 'en-US',
        link: '/en/',
        title: 'LLM Gateway Patterns',
        description: 'Production patterns for LLM gateways',
        themeConfig: {
          nav: enNav,
          sidebar: enSidebar,
          outline: { level: [2, 3], label: 'On this page' },
          footer: {
            message: '鱼心快跑，Bug 追不上 · MIT Licensed · Patterns over API docs',
            copyright: 'Copyright © 2026 yuxinrun'
          },
          lastUpdated: {
            text: 'Last updated',
            formatOptions: { dateStyle: 'medium', timeStyle: 'short' }
          },
          docFooter: { prev: 'Previous', next: 'Next' },
          editLink: {
            pattern: `${repo}/edit/main/docs/:path`,
            text: 'Edit this page on GitHub'
          },
          darkModeSwitchLabel: 'Appearance',
          lightModeSwitchTitle: 'Switch to light mode',
          darkModeSwitchTitle: 'Switch to dark mode',
          sidebarMenuLabel: 'Menu',
          returnToTopLabel: 'Return to top',
          langMenuLabel: 'Change language',
          notFound: {
            title: 'Page not found',
            quote: 'This URL has no matching page. Try the sidebar or the homepage.',
            linkLabel: 'Back to home',
            linkText: 'Back to home'
          }
        }
      }
    },
    themeConfig: {
      logo: { src: '/logo.svg', width: 24, height: 24, alt: 'LLM Gateway Patterns' },
      siteTitle: 'LLM Gateway Patterns',
      nav: zhNav,
      sidebar: zhSidebar,
      outline: { level: [2, 3], label: '本页目录' },
      socialLinks: [{ icon: 'github', link: repo, ariaLabel: 'GitHub' }],
      footer: {
        message: '鱼心快跑，Bug 追不上 · MIT Licensed · 讲模式，不堆接口文档',
        copyright: 'Copyright © 2026 yuxinrun'
      },
      lastUpdated: {
        text: '最后更新于',
        formatOptions: { dateStyle: 'medium', timeStyle: 'short' }
      },
      docFooter: { prev: '上一篇', next: '下一篇' },
      editLink: {
        pattern: `${repo}/edit/main/docs/:path`,
        text: '在 GitHub 上编辑此页'
      },
      darkModeSwitchLabel: '外观',
      lightModeSwitchTitle: '切换到浅色模式',
      darkModeSwitchTitle: '切换到深色模式',
      sidebarMenuLabel: '目录',
      returnToTopLabel: '回到顶部',
      langMenuLabel: '切换语言',
      externalLinkIcon: true,
      search: {
        provider: 'local',
        options: {
          locales: {
            root: {
              translations: {
                button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
                modal: {
                  noResultsText: '没有找到相关内容',
                  resetButtonTitle: '清除查询条件',
                  footer: {
                    selectText: '选择',
                    navigateText: '切换',
                    closeText: '关闭'
                  }
                }
              }
            },
            en: {
              translations: {
                button: { buttonText: 'Search docs', buttonAriaLabel: 'Search docs' },
                modal: {
                  noResultsText: 'No results found',
                  resetButtonTitle: 'Reset search',
                  footer: {
                    selectText: 'Select',
                    navigateText: 'Navigate',
                    closeText: 'Close'
                  }
                }
              }
            }
          }
        }
      },
      notFound: {
        title: '页面走丢了',
        quote: '这个地址没有对应的文档，试试从侧边栏或首页找找。',
        linkLabel: '回到首页',
        linkText: '回到首页'
      }
    }
  })
)
