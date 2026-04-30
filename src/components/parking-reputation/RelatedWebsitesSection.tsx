import { useEffect, useState } from 'react'
import { fetchBlogPosts } from '@/server/parking'
import type { BlogPost } from '@/types/parking'
import { BlogPostCard } from './BlogPostCard'
import { Carousel, CarouselSlide } from './Carousel'
import { LoadingState } from './LoadingState'
import { SectionTitle } from './SectionTitle'

const CAROUSEL_LIMIT = 7

interface RelatedWebsitesSectionProps {
  lotId: string
  count: number
  initialBlogPosts?: BlogPost[]
  showTitle?: boolean
  className?: string
  viewAllSlug?: string
}

export function RelatedWebsitesSection({
  lotId,
  count,
  initialBlogPosts,
  showTitle = true,
  className,
  viewAllSlug,
}: RelatedWebsitesSectionProps) {
  const [blogPosts, setBlogPosts] = useState<BlogPost[]>(initialBlogPosts ?? [])
  const [loading, setLoading] = useState(initialBlogPosts === undefined)

  useEffect(() => {
    setBlogPosts(initialBlogPosts ?? [])
    if (initialBlogPosts !== undefined) {
      setLoading(false)
      return
    }

    setLoading(true)
    fetchBlogPosts({ data: { parkingLotId: lotId, limit: CAROUSEL_LIMIT } })
      .then(setBlogPosts)
      .catch(() => setBlogPosts([]))
      .finally(() => setLoading(false))
  }, [lotId, initialBlogPosts])

  const visiblePosts = blogPosts.slice(0, CAROUSEL_LIMIT)
  const hasMore = blogPosts.length > CAROUSEL_LIMIT || count > CAROUSEL_LIMIT

  return (
    <section className={className}>
      {showTitle && (
        <SectionTitle
          title="관련 웹사이트"
          count={count}
          viewAll={hasMore && viewAllSlug ? { slug: viewAllSlug, tab: 'blog' } : undefined}
        />
      )}

      {visiblePosts.length > 0 ? (
        <Carousel>
          {visiblePosts.map((post) => (
            <CarouselSlide key={post.sourceUrl} size="review">
              <BlogPostCard post={post} lotId={lotId} />
            </CarouselSlide>
          ))}
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
