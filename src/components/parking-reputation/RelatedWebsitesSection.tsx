import { useEffect, useState } from 'react'
import { fetchBlogPosts } from '@/server/parking'
import type { BlogPost } from '@/types/parking'
import { BlogPostCard } from './BlogPostCard'
import { Carousel, CarouselArrows, CarouselProvider, CarouselSlide } from './Carousel'
import { LoadingState } from './LoadingState'
import { SectionTitle } from './SectionTitle'

const CAROUSEL_LIMIT = 7

interface RelatedWebsitesSectionProps {
  lotId: string
  count: number
  initialBlogPosts?: BlogPost[]
  showTitle?: boolean
  className?: string
  /** 흰 배경 컨텍스트에서 카드 테두리 표시 */
  bordered?: boolean
}

export function RelatedWebsitesSection({
  lotId,
  count,
  initialBlogPosts,
  showTitle = true,
  className,
  bordered,
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

  return (
    <section className={className}>
      <CarouselProvider>
        {showTitle && (
          <SectionTitle title="블로그 후기" count={count} actions={<CarouselArrows />} />
        )}

        {visiblePosts.length > 0 ? (
          <Carousel>
            {visiblePosts.map((post) => (
              <CarouselSlide key={post.sourceUrl} size="review">
                <BlogPostCard post={post} lotId={lotId} bordered={bordered} />
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
      </CarouselProvider>
    </section>
  )
}
