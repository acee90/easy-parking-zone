import { ReportButton } from '@/components/ReportDialog'
import type { BlogPost } from '@/types/parking'

const SOURCE_LABELS: Record<string, string> = {
  naver_blog: '블로그',
  naver_cafe: '카페',
  clien: '클리앙',
  poi: 'POI',
  naver_place: '플레이스',
}

export function BlogPostCard({ post, lotId }: { post: BlogPost; lotId: string }) {
  const sourceLabel = SOURCE_LABELS[post.source] ?? post.source
  return (
    <div className="relative h-full rounded-xl bg-muted px-4 py-4 transition-colors hover:bg-muted/80">
      <a href={post.sourceUrl} target="_blank" rel="noopener noreferrer" className="block">
        <p className="mb-2 line-clamp-2 pr-20 text-base font-semibold leading-snug text-gray-900">
          {post.title}
        </p>
        <p className="mb-3 line-clamp-3 text-sm leading-relaxed text-gray-600">{post.snippet}</p>
        <p className="text-xs text-muted-foreground">
          {sourceLabel} · {post.author}
          {post.publishedAt && ` · ${post.publishedAt.slice(0, 10)}`}
        </p>
      </a>
      <div className="absolute right-2 top-2">
        <ReportButton targetType="web_source" targetId={post.id} parkingLotId={lotId} />
      </div>
    </div>
  )
}
