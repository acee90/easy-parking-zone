import { ExternalLink } from 'lucide-react'
import { ReportButton } from '@/components/ReportDialog'
import type { BlogPost } from '@/types/parking'

const SOURCE_CONFIG: Record<string, { label: string; className: string }> = {
  naver_blog: { label: '블로그', className: 'bg-green-50 text-green-700 border-green-100' },
  naver_cafe: { label: '카페', className: 'bg-emerald-50 text-emerald-700 border-emerald-100' },
  clien: { label: '클리앙', className: 'bg-blue-50 text-blue-700 border-blue-100' },
  poi: { label: 'POI', className: 'bg-zinc-50 text-zinc-700 border-zinc-100' },
  naver_place: { label: '플레이스', className: 'bg-green-50 text-green-700 border-green-100' },
}

export function BlogPostCard({ post, lotId }: { post: BlogPost; lotId: string }) {
  const config = SOURCE_CONFIG[post.source] ?? {
    label: post.source,
    className: 'bg-zinc-50 text-zinc-700 border-zinc-100',
  }

  return (
    <div className="group relative rounded-2xl border bg-white p-5 transition-all hover:shadow-md">
      <a href={post.sourceUrl} target="_blank" rel="noopener noreferrer" className="block">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="flex-1">
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${config.className}`}
            >
              {config.label}
            </span>
            <h4 className="mt-2 line-clamp-2 text-lg font-bold leading-snug text-zinc-900 group-hover:text-blue-600 transition-colors">
              {post.title}
            </h4>
          </div>
          <div className="shrink-0 pt-1 opacity-0 transition-opacity group-hover:opacity-100">
            <ExternalLink className="size-4 text-zinc-400" />
          </div>
        </div>

        {post.snippet && (
          <p className="mb-4 line-clamp-3 text-sm leading-relaxed text-zinc-600">{post.snippet}</p>
        )}

        <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
          <span className="truncate">{post.author}</span>
          {post.publishedAt && (
            <>
              <span className="size-1 rounded-full bg-zinc-200" />
              <span>{post.publishedAt.slice(0, 10)}</span>
            </>
          )}
        </div>
      </a>
      <div className="absolute right-3 top-3 opacity-0 transition-opacity group-hover:opacity-100">
        <ReportButton targetType="web_source" targetId={post.id} parkingLotId={lotId} />
      </div>
    </div>
  )
}
