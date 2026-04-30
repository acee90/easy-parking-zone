import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
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
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-10 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Link
            to="/wiki/$slug"
            params={{ slug }}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            aria-label="주차장 상세로 돌아가기"
          >
            <ChevronLeft className="size-4" />
            돌아가기
          </Link>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">{lot.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">관련 영상 {media.length}건</p>
        </div>
        {media.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {media.map((item) => (
              <MediaCard key={item.id} media={item} lotId={lot.id} />
            ))}
          </div>
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">관련 영상이 없습니다</p>
        )}
      </div>
    </div>
  )
}
