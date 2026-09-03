import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * 영상 목록 페이지 → 상세페이지로 영구 이동 (301)
 *
 * v2 에서 영상 섹션을 걷어냈다. 상세페이지에서 뺀 크롤링 콘텐츠를 이 URL 이 그대로
 * 노출하고 있었기 때문이다. 그렇다고 404 로 두면 이미 색인된 URL 이 「찾을 수 없음」으로
 * 쌓이고 그동안 모인 신호도 버려진다. 영구 이동으로 상세페이지에 합친다.
 *
 * 화면을 그리지 않는다 — `beforeLoad` 에서 바로 나간다.
 */
export const Route = createFileRoute('/wiki/$slug/media')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/wiki/$slug', params, statusCode: 301 })
  },
})
