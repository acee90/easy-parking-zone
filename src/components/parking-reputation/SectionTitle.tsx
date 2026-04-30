import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

type ViewAllTab = 'reviews' | 'media' | 'blog'

interface SectionTitleProps {
  title: string
  count: number
  viewAll?: { slug: string; tab: ViewAllTab }
}

const TAB_TO_PATH = {
  reviews: '/wiki/$slug/reviews',
  media: '/wiki/$slug/media',
  blog: '/wiki/$slug/blog',
} as const

export function SectionTitle({ title, count, viewAll }: SectionTitleProps) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-2">
      <h3 className="flex items-baseline gap-2 text-xl font-bold tracking-normal text-zinc-950">
        {title}
        {count > 0 && <span className="text-sm font-normal text-muted-foreground">({count})</span>}
      </h3>
      {viewAll && (
        <Link
          to={TAB_TO_PATH[viewAll.tab]}
          params={{ slug: viewAll.slug }}
          className="flex shrink-0 items-center gap-0.5 text-sm font-medium text-blue-500 hover:text-blue-600"
        >
          전체 보기
          <ChevronRight className="size-3.5" />
        </Link>
      )}
    </div>
  )
}
