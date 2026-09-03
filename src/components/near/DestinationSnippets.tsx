import { ArrowUpRight } from 'lucide-react'
import { SectionShell } from '@/components/wiki/SectionShell'
import type { BlogPost } from '@/types/parking'

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * 이 근처 주차 후기 (#166, 기획 12-5절)
 *
 * 경쟁사가 "제가 갔을 때는" 을 지어내는 자리다. 우리는 이 목적지 이름을 실제로 담은 글만
 * 출처와 함께 보여준다. 원문 조각은 그리지 않는다 — 주차장 상세페이지와 같은 이유
 * (저작권, 긁어온 글 재게시 회피). 우리가 요약한 한 줄(ai_summary)이 있을 때만 요약을 붙이고,
 * 없으면 제목과 링크만 남긴다. 글이 한 건도 없으면 섹션을 그리지 않는다.
 */
export function DestinationSnippets({ posts, destName }: { posts: BlogPost[]; destName: string }) {
  if (posts.length === 0) return null

  return (
    <SectionShell
      title="이 근처 주차 후기"
      sub={`${posts.length}건`}
      note={`${destName}을(를) 언급한 웹 글입니다. 요약은 저희가 썼고, 원문은 출처에서 읽으실 수 있습니다.`}
    >
      <ul className="m-0 flex list-none flex-col divide-y divide-zinc-100 p-0">
        {posts.map((p) => (
          <li key={p.id} className="py-3 first:pt-0 last:pb-0">
            <a
              href={p.sourceUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="group flex items-start justify-between gap-2"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[14.5px] font-semibold text-ink group-hover:underline">
                  {p.title}
                </span>
                {p.summary && (
                  <span className="text-[13px] leading-[1.6] text-ink">{p.summary}</span>
                )}
                <span className="text-[11px] text-faint">
                  {hostOf(p.sourceUrl)}
                  {p.publishedAt && ` · ${p.publishedAt.slice(0, 10)}`}
                </span>
              </span>
              <ArrowUpRight className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </a>
          </li>
        ))}
      </ul>
    </SectionShell>
  )
}
