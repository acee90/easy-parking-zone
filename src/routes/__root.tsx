import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
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
        title: '쉬운주차 - 전국 주차장 난이도 지도',
      },
      {
        name: 'description',
        content: '전국 주차장의 주차 난이도를 💀 해골 개수로 한눈에! 초보운전자를 위한 주차장 찾기.',
      },
      {
        name: 'keywords',
        content: '주차장, 주차 난이도, 주차장 지도, 쉬운 주차, 주차장 찾기, 전국 주차장',
      },
      {
        name: 'theme-color',
        content: '#3b82f6',
      },
      {
        property: 'og:title',
        content: '쉬운주차 - 전국 주차장 난이도 지도',
      },
      {
        property: 'og:description',
        content: '전국 주차장의 주차 난이도를 💀 해골 개수로 한눈에! 초보운전자를 위한 주차장 찾기.',
      },
      {
        property: 'og:type',
        content: 'website',
      },
      {
        property: 'og:locale',
        content: 'ko_KR',
      },
      {
        property: 'og:site_name',
        content: '쉬운주차',
      },
    ],
    links: [
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/favicon.svg',
      },
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),

  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
