import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fetchBlogPosts } from '@/server/parking'
import type { BlogPost } from '@/types/parking'
import { BlogPostCard } from './BlogPostCard'
import { Carousel, CarouselSlide } from './Carousel'
import { LoadingState } from './LoadingState'
import { SectionTitle } from './SectionTitle'

const BLOG_PAGE_SIZE = 10

interface RelatedWebsitesSectionProps {
  lotId: string
  count: number
  initialBlogPosts?: BlogPost[]
  showTitle?: boolean
  className?: string
}

export function RelatedWebsitesSection({
  lotId,
  count,
  initialBlogPosts,
  showTitle = true,
  className,
}: RelatedWebsitesSectionProps) {
  const [blogPosts, setBlogPosts] = useState<BlogPost[]>(initialBlogPosts ?? [])
  const [hasMore, setHasMore] = useState((initialBlogPosts?.length ?? 0) >= BLOG_PAGE_SIZE)
  const [loading, setLoading] = useState(initialBlogPosts === undefined)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    setBlogPosts(initialBlogPosts ?? [])
    setHasMore((initialBlogPosts?.length ?? 0) >= BLOG_PAGE_SIZE)
    if (initialBlogPosts !== undefined) {
      setLoading(false)
      return
    }

    setLoading(true)
    fetchBlogPosts({ data: { parkingLotId: lotId, limit: BLOG_PAGE_SIZE } })
      .then((posts) => {
        setBlogPosts(posts)
        setHasMore(posts.length >= BLOG_PAGE_SIZE)
      })
      .catch(() => setBlogPosts([]))
      .finally(() => setLoading(false))
  }, [lotId, initialBlogPosts])

  const loadMore = () => {
    setLoadingMore(true)
    fetchBlogPosts({
      data: { parkingLotId: lotId, offset: blogPosts.length, limit: BLOG_PAGE_SIZE },
    })
      .then((posts) => {
        setBlogPosts((prev) => [...prev, ...posts])
        setHasMore(posts.length >= BLOG_PAGE_SIZE)
      })
      .catch(() => setHasMore(false))
      .finally(() => setLoadingMore(false))
  }

  return (
    <section className={className}>
      {showTitle && <SectionTitle title="관련 웹사이트" count={count} />}

      {blogPosts.length > 0 ? (
        <Carousel>
          {blogPosts.map((post) => (
            <CarouselSlide key={post.sourceUrl} size="review">
              <BlogPostCard post={post} lotId={lotId} />
            </CarouselSlide>
          ))}
          {hasMore && (
            <CarouselSlide size="more">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="h-full w-full rounded-lg border bg-white px-5 py-4 text-base font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                {loadingMore ? (
                  <span className="flex items-center justify-center gap-1.5">
                    <Loader2 className="size-3 animate-spin" /> 불러오는 중...
                  </span>
                ) : (
                  <span>
                    더보기 ({blogPosts.length}/{count})
                  </span>
                )}
              </button>
            </CarouselSlide>
          )}
        </Carousel>
      ) : loading ? (
        <LoadingState />
      ) : (
        <p className="py-6 text-center text-xs text-muted-foreground">
          관련 웹사이트 글이 없습니다
        </p>
      )}
    </section>
  )
}
