import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

type ViewAllTab = 'reviews' | 'media' | 'blog'

interface SectionTitleProps {
  title: string
  count: number
  viewAll?: { slug: string; tab: ViewAllTab }
  /** 타이틀 행 우측에 붙는 컨트롤 (캐러셀 이전/다음 버튼 등) */
  actions?: ReactNode
}

const TAB_TO_PATH = {
  reviews: '/wiki/$slug/reviews',
  media: '/wiki/$slug/media',
  blog: '/wiki/$slug/blog',
} as const

export function SectionTitle({ title, count, viewAll, actions }: SectionTitleProps) {
  return (
    <div className="mb-4 flex items-center justify-between gap-2">
      <h2 className="flex items-baseline gap-2 text-xl font-bold tracking-normal text-zinc-950">
        {title}
        {count > 0 && <span className="text-sm font-normal text-muted-foreground">({count})</span>}
      </h2>
      <div className="flex shrink-0 items-center gap-3">
        {viewAll && (
          <Link
            to={TAB_TO_PATH[viewAll.tab]}
            params={{ slug: viewAll.slug }}
            className="flex items-center gap-0.5 text-sm font-medium text-blue-500 hover:text-blue-600"
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
