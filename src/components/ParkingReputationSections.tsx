import { FileText, MessageSquare, Play } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { fetchTabCounts } from '@/server/parking'
import type { BlogPost, ParkingMedia, UserReview } from '@/types/parking'
import { MediaSection } from './parking-reputation/MediaSection'
import { RelatedWebsitesSection } from './parking-reputation/RelatedWebsitesSection'
import { ReviewSection } from './parking-reputation/ReviewSection'

interface ParkingReputationSectionsProps {
  lotId: string
  expanded?: boolean
  initialBlogPosts?: BlogPost[]
  initialMedia?: ParkingMedia[]
  initialReviews?: UserReview[]
  initialTabCounts?: { reviews: number; blog: number; media: number }
  /** 전체 보기 라우팅용 slug. 미지정 시 "전체 보기" 링크 미노출 */
  viewAllSlug?: string
}

export function ParkingReputationSections({
  lotId,
  expanded,
  initialBlogPosts,
  initialMedia,
  initialReviews,
  initialTabCounts,
  viewAllSlug,
}: ParkingReputationSectionsProps) {
  const [activeTab, setActiveTab] = useState<'reviews' | 'media' | 'blog'>('reviews')
  const [counts, setCounts] = useState(initialTabCounts ?? { reviews: 0, blog: 0, media: 0 })

  const refreshCounts = useCallback(() => {
    fetchTabCounts({ data: { parkingLotId: lotId } })
      .then(setCounts)
      .catch(() => {})
  }, [lotId])

  useEffect(() => {
    setActiveTab('reviews')
    setCounts(initialTabCounts ?? { reviews: 0, blog: 0, media: 0 })

    if (initialTabCounts === undefined) {
      refreshCounts()
    }
  }, [initialTabCounts, refreshCounts])

  if (expanded) {
    return (
      <div>
        <ReviewSection
          lotId={lotId}
          count={counts.reviews}
          initialReviews={initialReviews}
          onRefreshCount={refreshCounts}
          className="border-t-2 border-zinc-300 pt-7 pb-8"
          viewAllSlug={viewAllSlug}
        />
        <MediaSection
          lotId={lotId}
          count={counts.media}
          initialMedia={initialMedia}
          className="border-t-2 border-zinc-300 pt-7 pb-8"
          viewAllSlug={viewAllSlug}
        />
        <RelatedWebsitesSection
          lotId={lotId}
          count={counts.blog}
          initialBlogPosts={initialBlogPosts}
          className="border-t-2 border-zinc-300 pt-7"
          viewAllSlug={viewAllSlug}
        />
      </div>
    )
  }

  const tabs = [
    {
      key: 'reviews' as const,
      icon: <MessageSquare className="size-3.5" />,
      label: '리뷰',
      count: counts.reviews,
    },
    {
      key: 'media' as const,
      icon: <Play className="size-3.5" />,
      label: '영상',
      count: counts.media,
    },
    {
      key: 'blog' as const,
      icon: <FileText className="size-3.5" />,
      label: '웹사이트',
      count: counts.blog,
    },
  ]

  return (
    <div className="border-t">
      <div className="flex">
        {tabs.map(({ key, icon, label, count }) => (
          <button
            type="button"
            key={key}
            onClick={() => setActiveTab(key)}
            className={`flex-1 cursor-pointer border-b-2 py-2.5 text-xs font-medium transition-colors ${
              activeTab === key
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <span className="flex items-center justify-center gap-1.5">
              {icon}
              {label}
              {count > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                    activeTab === key ? 'bg-blue-50 text-blue-600' : 'bg-zinc-100 text-zinc-500'
                  }`}
                >
                  {count}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>

      <div className="px-0 py-3">
        {activeTab === 'reviews' && (
          <ReviewSection
            lotId={lotId}
            count={counts.reviews}
            showTitle={false}
            onRefreshCount={refreshCounts}
          />
        )}
        {activeTab === 'media' && (
          <MediaSection lotId={lotId} count={counts.media} showTitle={false} />
        )}
        {activeTab === 'blog' && (
          <RelatedWebsitesSection lotId={lotId} count={counts.blog} showTitle={false} />
        )}
      </div>
    </div>
  )
}
