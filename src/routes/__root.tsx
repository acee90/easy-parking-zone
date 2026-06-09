import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useMatches,
  useNavigate,
} from '@tanstack/react-router'
import { useCallback, useEffect } from 'react'
import { Toaster } from 'sonner'
import { Footer } from '@/components/Footer'
import { Header } from '@/components/Header'
import { makeParkingSlug } from '@/lib/slug'
import { fetchSiteStats } from '@/server/parking'
import type { ParkingLot } from '@/types/parking'

import appCss from '../styles.css?url'

const SITE_URL = 'https://easy-parking.xyz'
const SITE_NAME = '쉽주'
const SITE_TITLE = '쉽주 — 전국 주차장 난이도 지도'
const SITE_DESC = '주차하기 전에 한 번만 확인하세요. 전국 주차장 난이도, 요금, 운영시간을 한눈에.'

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
        content:
          'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover',
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
          '쉽주, 쉬운주차장, 주차 난이도, 주차장 지도, 주차장 요금, 주차장 운영시간, 초보운전 주차, 전국 주차장 정보',
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
        property: 'og:image:alt',
        content: SITE_TITLE,
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
  }),

  shellComponent: RootDocument,
})

// TanStack Start head API의 scripts가 SSR HTML로 직렬화되지 않아
// RootDocument의 <head>에 직접 inject한다.
const WEBSITE_JSONLD = JSON.stringify({
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
})

function RootComponent() {
  useEffect(() => {
    if (import.meta.env.DEV) {
      void import('react-grab')
    }
  }, [])

  const siteStats = Route.useLoaderData()
  const navigate = useNavigate()
  // 현재 라우트 경로로 active 탭 결정
  const matches = useMatches()
  const lastMatch = matches[matches.length - 1]
  const active = lastMatch?.fullPath?.startsWith('/wiki') ? ('wiki' as const) : ('map' as const)
  const isMap = lastMatch?.fullPath === '/'
  const isAdmin = lastMatch?.fullPath?.startsWith('/admin') ?? false
  // admin 외 모든 페이지에 footer 노출 (지도 홈 포함 — SEO discovery용)
  const showFooter = !isAdmin
  const handleWikiSearchSelect = useCallback(
    (lot: ParkingLot) => {
      navigate({
        to: '/wiki/$slug',
        params: { slug: makeParkingSlug(lot.name, lot.id) },
      })
    },
    [navigate],
  )

  return (
    <>
      {!isMap && (
        <Header
          active={active}
          onSearchSelect={active === 'wiki' ? handleWikiSearchSelect : undefined}
          siteStats={siteStats}
        />
      )}
      <Outlet />
      {showFooter && <Footer />}
    </>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <HeadContent />
        <link rel="icon" type="image/png" sizes="512x512" href="/favicon-512.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <link rel="stylesheet" href={appCss} />
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON.stringify output is safe
          dangerouslySetInnerHTML={{ __html: WEBSITE_JSONLD }}
        />
        {process.env.NODE_ENV === 'production' && (
          <>
            <script async src="https://www.googletagmanager.com/gtag/js?id=G-7FB8JKK2HD" />
            <script
              dangerouslySetInnerHTML={{
                __html: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-7FB8JKK2HD');`,
              }}
            />
          </>
        )}
      </head>
      <body>
        {children}
        <Toaster position="bottom-center" richColors />
        <Scripts />
      </body>
    </html>
  )
}
