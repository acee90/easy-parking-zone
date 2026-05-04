import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ChevronLeft, FileText, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { BlogPostCard } from '@/components/parking-reputation/BlogPostCard'
import { makeParkingSlug, parseIdFromSlug } from '@/lib/slug'
import { fetchBlogPosts, fetchParkingDetail } from '@/server/parking'
import type { BlogPost } from '@/types/parking'

const PAGE_SIZE = 20

export const Route = createFileRoute('/wiki/$slug/blog')({
  loader: async ({ params }) => {
    const id = parseIdFromSlug(params.slug)
    if (!id) throw notFound()
    const [lot, posts] = await Promise.all([
      fetchParkingDetail({ data: { id } }),
      fetchBlogPosts({ data: { parkingLotId: id, limit: PAGE_SIZE } }),
    ])
    if (!lot) throw notFound()
    return { lot, posts }
  },
  head: ({ loaderData }) => {
    const lot = loaderData?.lot
    if (!lot) return {}
    const slug = makeParkingSlug(lot.name, lot.id)
    return {
      meta: [
        { title: `${lot.name} 관련 웹사이트 | 쉬운주차장` },
        { name: 'robots', content: 'noindex, follow' },
      ],
      links: [{ rel: 'canonical', href: `https://easy-parking.xyz/wiki/${slug}` }],
    }
  },
  component: BlogListPage,
})

function BlogListPage() {
  const { lot, posts: initialPosts } = Route.useLoaderData()
  const [posts, setPosts] = useState<BlogPost[]>(initialPosts)
  const [hasMore, setHasMore] = useState(initialPosts.length >= PAGE_SIZE)
  const [loadingMore, setLoadingMore] = useState(false)
  const slug = makeParkingSlug(lot.name, lot.id)

  const loadMore = () => {
    setLoadingMore(true)
    fetchBlogPosts({
      data: { parkingLotId: lot.id, offset: posts.length, limit: PAGE_SIZE },
    })
      .then((next) => {
        setPosts((prev) => [...prev, ...next])
        setHasMore(next.length >= PAGE_SIZE)
      })
      .catch(() => setHasMore(false))
      .finally(() => setLoadingMore(false))
  }

  return (
    <div className="min-h-screen bg-zinc-50/50">
      <header className="sticky top-0 z-10 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
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
              <p className="text-xs text-zinc-500">관련 웹사이트 {posts.length}건</p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        {/* 요약 섹션 */}
        <section className="mb-10 rounded-3xl border bg-white p-8 shadow-sm">
          <div className="flex flex-col items-center gap-6 text-center md:flex-row md:text-left">
            <div className="flex size-20 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
              <FileText className="size-10" />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <div className="flex items-center gap-2 text-xl font-bold text-zinc-900">
                <span>웹상의 다양한 정보를 모아보았습니다</span>
              </div>
              <p className="text-sm leading-relaxed text-zinc-500">
                블로그, 카페, 커뮤니티 등 인터넷 곳곳에 흩어져 있는 이 주차장에 대한 생생한 후기와
                꿀팁들을 한눈에 확인해보세요.
              </p>
            </div>
          </div>
        </section>

        {posts.length > 0 ? (
          <>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {posts.map((post) => (
                <BlogPostCard key={post.sourceUrl} post={post} lotId={lot.id} />
              ))}
            </div>
            {hasMore && (
              <div className="mt-10 flex justify-center">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="inline-flex h-12 items-center justify-center rounded-2xl border bg-white px-10 text-sm font-bold text-zinc-900 shadow-sm transition-all hover:bg-zinc-50 hover:shadow-md disabled:opacity-50 active:scale-95"
                >
                  {loadingMore ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="size-4 animate-spin text-blue-600" />
                      불러오는 중...
                    </span>
                  ) : (
                    <span>정보 더보기</span>
                  )}
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-zinc-100">
              <FileText className="size-8 text-zinc-300" />
            </div>
            <p className="text-lg font-bold text-zinc-900">관련 정보가 없습니다</p>
            <p className="mt-1 text-sm text-zinc-500">
              아직 이 주차장에 대한 웹 정보를 찾지 못했습니다.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
