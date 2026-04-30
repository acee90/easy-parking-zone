import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ChevronLeft, Loader2 } from 'lucide-react'
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
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-10 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
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
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">{lot.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">관련 웹사이트 {posts.length}건</p>
        </div>
        {posts.length > 0 ? (
          <>
            <div className="space-y-3">
              {posts.map((post) => (
                <BlogPostCard key={post.sourceUrl} post={post} lotId={lot.id} />
              ))}
            </div>
            {hasMore && (
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="mt-6 w-full rounded-lg border bg-white py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                {loadingMore ? (
                  <span className="flex items-center justify-center gap-1.5">
                    <Loader2 className="size-3.5 animate-spin" /> 불러오는 중...
                  </span>
                ) : (
                  <span>더보기</span>
                )}
              </button>
            )}
          </>
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">
            관련 웹사이트 글이 없습니다
          </p>
        )}
      </div>
    </div>
  )
}
