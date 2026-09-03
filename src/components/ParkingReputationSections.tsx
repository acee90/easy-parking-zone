import { FileText, MessageSquare, Play } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { fetchTabCounts } from '@/server/parking'
import type { BlogPost, ParkingMedia, UserReview } from '@/types/parking'
import { MediaSection } from './parking-reputation/MediaSection'
import { RelatedWebsitesSection } from './parking-reputation/RelatedWebsitesSection'
import { ReviewSection } from './parking-reputation/ReviewSection'
import { WriteReviewSection } from './parking-reputation/WriteReviewSection'

interface ParkingReputationSectionsProps {
  lotId: string
  expanded?: boolean
  initialBlogPosts?: BlogPost[]
  initialMedia?: ParkingMedia[]
  initialReviews?: UserReview[]
  initialTabCounts?: { reviews: number; blog: number; media: number }
  /** 전체 보기 라우팅용 slug. 미지정 시 "전체 보기" 링크 미노출 */
  viewAllSlug?: string
  /** 흰 배경 컨텍스트(지도 패널/바텀시트)에서 카드 테두리 표시 */
  bordered?: boolean
  /**
   * expanded 모드에서 렌더할 섹션과 순서. 미지정 시 전부 렌더한다.
   * 상세페이지가 이용자 후기와 웹 글 사이에 다른 블록(AI 요약·요금 계산 등)을
   * 끼워 넣을 수 있도록 쪼갤 수 있게 열어둔 것이다.
   */
  sections?: ExpandedSection[]
}

export type ExpandedSection = 'reviews' | 'write' | 'media' | 'blog'

const ALL_SECTIONS: ExpandedSection[] = ['reviews', 'write', 'media', 'blog']

export function ParkingReputationSections({
  lotId,
  expanded,
  initialBlogPosts,
  initialMedia,
  initialReviews,
  initialTabCounts,
  viewAllSlug,
  bordered,
  sections,
}: ParkingReputationSectionsProps) {
  const [activeTab, setActiveTab] = useState<'reviews' | 'media' | 'blog'>('reviews')
  const [counts, setCounts] = useState(initialTabCounts ?? { reviews: 0, blog: 0, media: 0 })
  const [reviewRefreshKey, setReviewRefreshKey] = useState(0)

  const refreshCounts = useCallback(() => {
    fetchTabCounts({ data: { parkingLotId: lotId } })
      .then(setCounts)
      .catch(() => {})
  }, [lotId])

  const handleReviewSubmitted = useCallback(() => {
    setReviewRefreshKey((k) => k + 1)
    refreshCounts()
  }, [refreshCounts])

  useEffect(() => {
    setActiveTab('reviews')
    setCounts(initialTabCounts ?? { reviews: 0, blog: 0, media: 0 })

    if (initialTabCounts === undefined) {
      refreshCounts()
    }
  }, [initialTabCounts, refreshCounts])

  if (expanded) {
    const visible = sections ?? ALL_SECTIONS
    // `sections` 에 준 **순서대로** 그린다. 예전에는 컴포넌트 안에 순서가 박혀 있어
    // 호출부에서 바꿀 수 없었다 — 후기 작성이 목록보다 먼저 나와야 하는 화면이 있다.
    const render = {
      reviews: (
        <ReviewSection
          key="reviews"
          lotId={lotId}
          count={counts.reviews}
          initialReviews={initialReviews}
          onRefreshCount={refreshCounts}
          viewAllSlug={viewAllSlug}
          refreshKey={reviewRefreshKey}
          bordered={bordered}
        />
      ),
      write: <WriteReviewSection key="write" lotId={lotId} onSubmitted={handleReviewSubmitted} />,
      media: (
        <MediaSection
          key="media"
          lotId={lotId}
          count={counts.media}
          initialMedia={initialMedia}
          bordered={bordered}
        />
      ),
      blog: (
        <RelatedWebsitesSection
          key="blog"
          lotId={lotId}
          count={counts.blog}
          initialBlogPosts={initialBlogPosts}
          bordered={bordered}
        />
      ),
    } as const

    return <div className="space-y-8 pt-1">{visible.map((k) => render[k])}</div>
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
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <span className="flex items-center justify-center gap-1.5">
              {icon}
              {label}
              {count > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                    activeTab === key ? 'bg-primary/5 text-primary' : 'bg-zinc-100 text-zinc-500'
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
            bordered={bordered}
          />
        )}
        {activeTab === 'media' && (
          <MediaSection lotId={lotId} count={counts.media} showTitle={false} bordered={bordered} />
        )}
        {activeTab === 'blog' && (
          <RelatedWebsitesSection
            lotId={lotId}
            count={counts.blog}
            showTitle={false}
            bordered={bordered}
          />
        )}
      </div>
    </div>
  )
}
