import { createFileRoute, Link } from '@tanstack/react-router'
import { LegalSection, LegalShell } from '@/components/legal/LegalShell'

export const Route = createFileRoute('/about')({
  head: () => ({
    meta: [
      { title: '서비스 소개 | 쉬운주차장' },
      {
        name: 'description',
        content:
          '쉬운주차장은 전국 주차장의 난이도·요금·운영시간을 실제 후기 기반으로 정리해 주차 전에 미리 확인할 수 있게 돕는 서비스입니다.',
      },
      {
        name: 'robots',
        content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
      },
      { property: 'og:title', content: '서비스 소개 | 쉬운주차장' },
      {
        property: 'og:description',
        content: '전국 주차장 난이도·요금·운영시간을 실제 후기 기반으로 정리합니다.',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:url', content: 'https://easy-parking.xyz/about' },
    ],
    links: [{ rel: 'canonical', href: 'https://easy-parking.xyz/about' }],
  }),
  component: AboutPage,
})

function AboutPage() {
  return (
    <LegalShell title="서비스 소개">
      <LegalSection heading="쉬운주차장이란">
        <p>
          쉬운주차장(쉽주)은 전국 주차장의 <strong>진입 난이도, 요금, 운영시간, 주차면 수</strong>를
          한곳에 모아 비교할 수 있게 정리한 서비스입니다. 처음 가는 목적지에서 “여기 주차하기 어렵지
          않을까?”라는 고민을 미리 덜어 드리는 것을 목표로 합니다.
        </p>
      </LegalSection>

      <LegalSection heading="무엇을 제공하나요">
        <ul className="list-disc space-y-2 pl-5">
          <li>전국 주차장 위치를 지도에서 한눈에 탐색</li>
          <li>초보 운전자 관점의 주차 난이도 점수와 방문 팁</li>
          <li>요금·운영시간·주차면 수 등 기본 정보 비교</li>
          <li>실제 블로그·영상 후기와 이용자 리뷰 모음</li>
        </ul>
      </LegalSection>

      <LegalSection heading="정보의 출처">
        <p>
          주차장 기본 정보의 일부는 공공데이터포털(data.go.kr)의 전국주차장정보표준데이터를
          활용하며, 후기·난이도 정보는 공개된 웹 콘텐츠와 이용자 제보를 정리해 제공합니다.
          운영시간과 요금은 변경될 수 있으므로 방문 전 현장 안내를 함께 확인해 주세요.
        </p>
      </LegalSection>

      <LegalSection heading="더 둘러보기">
        <p className="flex flex-wrap gap-3">
          <Link to="/wiki" className="text-blue-600 underline underline-offset-2">
            전국 주차장 둘러보기
          </Link>
          <Link to="/contact" className="text-blue-600 underline underline-offset-2">
            문의하기
          </Link>
        </p>
      </LegalSection>
    </LegalShell>
  )
}
