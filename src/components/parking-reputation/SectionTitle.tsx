import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * 「전체 보기」가 갈 수 있는 곳.
 *
 * media·blog 하위 라우트는 삭제했다 — 상세페이지에서 걷어낸 크롤링 원문을
 * 그 URL 들이 그대로 노출하고 있었다. 우리가 쓴 이용자 후기만 남는다.
 */
type ViewAllTab = 'reviews'

interface SectionTitleProps {
  title: string
  count: number
  viewAll?: { slug: string; tab: ViewAllTab }
  /** 타이틀 행 우측에 붙는 컨트롤 (캐러셀 이전/다음 버튼 등) */
  actions?: ReactNode
}

const TAB_TO_PATH = {
  reviews: '/wiki/$slug/reviews',
} as const

export function SectionTitle({ title, count, viewAll, actions }: SectionTitleProps) {
  return (
    <div className="mb-[11px] flex items-center justify-between gap-2">
      <h2 className="m-0 flex items-baseline gap-1.5 text-[17px] font-extrabold tracking-[-0.015em] text-ink">
        {title}
        {count > 0 && (
          <span className="text-[13px] font-bold tabular-nums text-faint">{count}</span>
        )}
      </h2>
      <div className="flex shrink-0 items-center gap-2">
        {viewAll && (
          <Link
            to={TAB_TO_PATH[viewAll.tab]}
            params={{ slug: viewAll.slug }}
            className="inline-flex h-8 items-center gap-0.5 rounded-full bg-hair-2 pl-3 pr-2 text-[11.5px] font-semibold text-ink-2 transition-colors hover:bg-hair"
          >
            전체 보기
            <ChevronRight className="size-3.5" />
          </Link>
        )}
        {actions}
      </div>
    </div>
  )
}
