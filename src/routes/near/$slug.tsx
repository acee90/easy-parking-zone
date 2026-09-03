import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { buildDestinationFaq, DestinationFaq } from '@/components/near/DestinationFaq'
import { DestinationHero } from '@/components/near/DestinationHero'
import { DestinationLotList } from '@/components/near/DestinationLotList'
import { DestinationSnippets } from '@/components/near/DestinationSnippets'
import { EasiestPicks, pickEasiest } from '@/components/near/EasiestPicks'
import { WikiMiniMap } from '@/components/WikiMiniMap'
import { SectionShell } from '@/components/wiki/SectionShell'
import {
  buildDestinationBreadcrumbJsonLd,
  buildDestinationDescription,
  buildDestinationJsonLd,
  buildDestinationTitle,
  getDestinationCanonicalUrl,
} from '@/lib/destination-jsonld'
import { parseDestinationIdFromSlug } from '@/lib/slug'
import {
  fetchDestination,
  fetchDestinationLots,
  fetchDestinationSnippets,
} from '@/server/destinations'

/**
 * 목적지 페이지 /near/{목적지} (#166)
 *
 * 행이 있으면 발행이다. robots 분기가 없다 — noindex 상태를 두지 않기로 했다
 * (docs/exec-plans/issue-166-implementation-plan.md 0-1절).
 */
export const Route = createFileRoute('/near/$slug')({
  loader: async ({ params }) => {
    const id = parseDestinationIdFromSlug(params.slug)
    if (!id) throw notFound()
    const dest = await fetchDestination({ data: { id } })
    if (!dest) throw notFound()
    const [lots, snippets] = await Promise.all([
      fetchDestinationLots({ data: { destinationId: id } }),
      fetchDestinationSnippets({ data: { destinationId: id } }),
    ])
    return { dest, lots, snippets }
  },
  head: ({ loaderData }) => {
    const dest = loaderData?.dest
    const lots = loaderData?.lots ?? []
    if (!dest) return {}
    const easyCount = pickEasiest(lots).length
    const title = buildDestinationTitle(dest, easyCount)
    const desc = buildDestinationDescription(dest, lots)
    const canonicalUrl = getDestinationCanonicalUrl(dest)
    return {
      meta: [
        { title },
        { name: 'description', content: desc },
        {
          name: 'robots',
          content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
        },
        { property: 'og:title', content: title },
        { property: 'og:description', content: desc },
        { property: 'og:type', content: 'article' },
        { property: 'og:url', content: canonicalUrl },
      ],
    }
  },
  notFoundComponent: () => (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-bold">아직 준비되지 않은 목적지입니다</h1>
      <p className="text-muted-foreground">지도에서 검색하면 주변 주차장을 바로 볼 수 있습니다.</p>
      <Link
        to="/"
        search={{ lotId: undefined, near: undefined }}
        className="text-primary underline"
      >
        지도로 가기
      </Link>
    </div>
  ),
  component: DestinationPage,
})

function DestinationPage() {
  const { dest, lots, snippets } = Route.useLoaderData()
  const easiest = pickEasiest(lots)
  const faq = buildDestinationFaq(dest, lots, easiest[0])
  const canonicalUrl = getDestinationCanonicalUrl(dest)
  const { place, list } = buildDestinationJsonLd(dest, lots)
  const breadcrumb = buildDestinationBreadcrumbJsonLd(dest)

  return (
    <div className="min-h-screen bg-zinc-100">
      {/* canonical/JSON-LD 는 wiki 와 같은 이유로 React 19 metadata hoisting 으로 head 에 넣는다 */}
      <link rel="canonical" href={canonicalUrl} />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON.stringify output is safe
        dangerouslySetInnerHTML={{ __html: JSON.stringify(place) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON.stringify output is safe
        dangerouslySetInnerHTML={{ __html: JSON.stringify(list) }}
      />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON.stringify output is safe
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
      />
      {/* 주차장 상세페이지와 같은 흰 시트 1장 + 내부 디바이더 (표면 규칙 §4) */}
      <div className="mx-auto max-w-[900px] px-4 py-5 text-[15px] leading-[1.65] md:px-5 md:py-6">
        <div className="flex flex-col divide-y divide-zinc-100 rounded-[10px] bg-white [&>*]:px-4 [&>*]:py-5 md:[&>*]:px-6">
          <DestinationHero dest={dest} lots={lots} easyCount={easiest.length} />
          <EasiestPicks picks={easiest} />
          <DestinationLotList lots={lots} />
          <SectionShell
            title="위치"
            note={
              dest.source.startsWith('osm:')
                ? '목적지 좌표 © OpenStreetMap contributors (ODbL). 주차장 핀은 지도에서 보기로 확인하세요.'
                : '목적지 핀입니다. 주차장 핀은 지도에서 보기로 확인하세요.'
            }
          >
            <WikiMiniMap lat={dest.lat} lng={dest.lng} name={dest.name} />
            <div className="mt-3">
              <Link
                to="/"
                search={{ lotId: undefined, near: dest.id }}
                className="text-[13px] font-semibold text-ink underline underline-offset-2"
              >
                지도에서 주변 주차장 보기
              </Link>
            </div>
          </SectionShell>
          <DestinationSnippets posts={snippets} destName={dest.name} />
          <DestinationFaq items={faq} />
        </div>
      </div>
    </div>
  )
}
