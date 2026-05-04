import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ChevronLeft, Play, Youtube } from 'lucide-react'
import { MediaCard } from '@/components/parking-reputation/MediaCard'
import { makeParkingSlug, parseIdFromSlug } from '@/lib/slug'
import { fetchParkingDetail, fetchParkingMedia } from '@/server/parking'

export const Route = createFileRoute('/wiki/$slug/media')({
  loader: async ({ params }) => {
    const id = parseIdFromSlug(params.slug)
    if (!id) throw notFound()
    const [lot, media] = await Promise.all([
      fetchParkingDetail({ data: { id } }),
      fetchParkingMedia({ data: { parkingLotId: id, limit: 100 } }),
    ])
    if (!lot) throw notFound()
    return { lot, media }
  },
  head: ({ loaderData }) => {
    const lot = loaderData?.lot
    if (!lot) return {}
    const slug = makeParkingSlug(lot.name, lot.id)
    return {
      meta: [
        { title: `${lot.name} 영상 | 쉬운주차장` },
        { name: 'robots', content: 'noindex, follow' },
      ],
      links: [{ rel: 'canonical', href: `https://easy-parking.xyz/wiki/${slug}` }],
    }
  },
  component: MediaListPage,
})

function MediaListPage() {
  const { lot, media } = Route.useLoaderData()
  const slug = makeParkingSlug(lot.name, lot.id)

  return (
    <div className="min-h-screen bg-zinc-50/50">
      <header className="sticky top-0 z-10 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <Link
              to="/wiki/$slug"
              params={{ slug }}
              className="flex size-9 items-center justify-center rounded-full border bg-white text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
              aria-label="주차장 상세로 돌아가기"
            >
              <ChevronLeft className="size-5" />
            </Link>
            <div className="flex flex-col">
              <h1 className="text-base font-bold text-zinc-900 line-clamp-1">{lot.name}</h1>
              <p className="text-xs text-zinc-500">관련 영상 {media.length}건</p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {/* 요약 섹션 */}
        <section className="mb-10 rounded-3xl border bg-white p-8 shadow-sm">
          <div className="flex flex-col items-center gap-6 text-center md:flex-row md:text-left">
            <div className="flex size-20 shrink-0 items-center justify-center rounded-2xl bg-red-50 text-red-600">
              <Youtube className="size-10" />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <div className="flex items-center gap-2 text-xl font-bold text-zinc-900">
                <span>주차장 현장감을 영상으로 확인하세요</span>
              </div>
              <p className="text-sm leading-relaxed text-zinc-500">
                유튜브 등 다양한 플랫폼의 영상을 통해 진입로 상태와 주차 공간의 실제 모습을 미리
                확인하고 안심하고 방문하세요.
              </p>
            </div>
          </div>
        </section>

        {media.length > 0 ? (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {media.map((item) => (
              <MediaCard key={item.id} media={item} lotId={lot.id} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-zinc-100">
              <Play className="size-8 text-zinc-300" />
            </div>
            <p className="text-lg font-bold text-zinc-900">관련 영상이 없습니다</p>
            <p className="mt-1 text-sm text-zinc-500">
              이 주차장에 대한 영상 정보를 아직 찾지 못했습니다.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
