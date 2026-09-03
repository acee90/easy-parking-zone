import { Play } from 'lucide-react'
import { ReportButton } from '@/components/ReportDialog'
import type { ParkingMedia } from '@/types/parking'
import { decodeHtmlEntities } from './utils'

export function MediaCard({
  media,
  lotId,
  bordered,
}: {
  media: ParkingMedia
  lotId: string
  /** 흰 배경 컨텍스트(지도 패널 등)에서 카드 경계를 위해 테두리 표시 */
  bordered?: boolean
}) {
  const title = media.title ? decodeHtmlEntities(media.title) : '제목 없음'
  // 설명문은 유튜브에서 긁어온 원문이다. 링크로 보내는 것으로 충분하고,
  // 우리 페이지에 남의 글을 싣지 않는다는 v2 원칙과 어긋나서 렌더하지 않는다.

  return (
    <div
      className={`group relative flex h-full w-full flex-col overflow-hidden rounded-2xl bg-white ${bordered ? 'border border-zinc-200' : ''}`}
    >
      <a
        href={media.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex h-full min-w-0 flex-col"
      >
        <div className="relative aspect-video w-full overflow-hidden bg-zinc-100">
          {media.thumbnailUrl ? (
            <img
              src={media.thumbnailUrl}
              alt=""
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Play className="size-10 text-zinc-300" />
            </div>
          )}
          <div className="absolute inset-0 flex items-center justify-center bg-black/10 opacity-0 transition-opacity group-hover:opacity-100">
            <div className="flex size-12 items-center justify-center rounded-full bg-red-600 text-white shadow-lg">
              <Play className="ml-0.5 size-6 fill-current" />
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col p-4">
          <p className="mb-2 line-clamp-2 text-base font-bold leading-snug text-zinc-900 transition-colors group-hover:text-primary">
            {title}
          </p>
        </div>
      </a>
      <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100">
        <ReportButton targetType="media" targetId={media.id} parkingLotId={lotId} />
      </div>
    </div>
  )
}
