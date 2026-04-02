import { createRootRoute, HeadContent, Outlet, Scripts, useMatches } from '@tanstack/react-router'
import { Header } from '@/components/Header'
import { fetchSiteStats } from '@/server/parking'

import appCss from '../styles.css?url'

const SITE_URL = 'https://easy-parking.xyz'
const SITE_NAME = '쉬운주차장 (쉽주)'
const SITE_TITLE = '쉬운주차장 (쉽주) - 전국 주차장 난이도 지도'
const SITE_DESC =
  '초보운전자를 위한 전국 주차장 난이도 정보! "쉽주"에서 주차장 찾기, 요금, 편의 시설을 한눈에 확인하세요.'

export const Route = createRootRoute({
  loader: () => fetchSiteStats(),
  component: RootComponent,
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no',
      },
      {
        title: SITE_TITLE,
      },
      {
        name: 'description',
        content: SITE_DESC,
      },
      {
        name: 'keywords',
        content:
          '쉽주, 쉬운주차장, 주차 난이도, 주차장 지도, 쉬운 주차, 주차장 찾기, 전국 주차장, 초보운전 주차, 주차 쉬운 곳',
      },
      {
        name: 'theme-color',
        content: '#3b82f6',
      },
      // Open Graph
      {
        property: 'og:title',
        content: SITE_TITLE,
      },
      {
        property: 'og:description',
        content: SITE_DESC,
      },
      {
        property: 'og:type',
        content: 'website',
      },
      {
        property: 'og:url',
        content: SITE_URL,
      },
      {
        property: 'og:image',
        content: `${SITE_URL}/og-image.png`,
      },
      {
        property: 'og:image:width',
        content: '1200',
      },
      {
        property: 'og:image:height',
        content: '630',
      },
      {
        property: 'og:locale',
        content: 'ko_KR',
      },
      {
        property: 'og:site_name',
        content: SITE_NAME,
      },
      // Twitter Card
      {
        name: 'twitter:card',
        content: 'summary_large_image',
      },
      {
        name: 'twitter:title',
        content: SITE_TITLE,
      },
      {
        name: 'twitter:description',
        content: SITE_DESC,
      },
      {
        name: 'twitter:image',
        content: `${SITE_URL}/og-image.png`,
      },
    ],
    links: [
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/favicon.svg',
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '32x32',
        href: '/favicon-32.png',
      },
      {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: '/apple-touch-icon.png',
      },
      {
        rel: 'manifest',
        href: '/site.webmanifest',
      },
      {
        rel: 'canonical',
        href: SITE_URL,
      },
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
    headScripts: [
      {
        type: 'application/ld+json',
        children: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: SITE_NAME,
          url: SITE_URL,
          description: SITE_DESC,
          inLanguage: 'ko',
          potentialAction: {
            '@type': 'SearchAction',
            target: `${SITE_URL}/?q={search_term_string}`,
            'query-input': 'required name=search_term_string',
          },
        }),
      },
    ],
  }),

  shellComponent: RootDocument,
})

function RootComponent() {
  const siteStats = Route.useLoaderData()
  // 현재 라우트 경로로 active 탭 결정
  const matches = useMatches()
  const lastMatch = matches[matches.length - 1]
  const active = lastMatch?.fullPath?.startsWith('/wiki') ? ('wiki' as const) : ('map' as const)
  // 지도 페이지가 아니면 검색바/필터 없음 — 각 페이지에서 별도 처리
  const isMap = lastMatch?.fullPath === '/'

  return (
    <>
      {!isMap && <Header active={active} siteStats={siteStats} />}
      <Outlet />
    </>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <HeadContent />
        <script async src="https://www.googletagmanager.com/gtag/js?id=G-7FB8JKK2HD" />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-7FB8JKK2HD');`,
          }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
