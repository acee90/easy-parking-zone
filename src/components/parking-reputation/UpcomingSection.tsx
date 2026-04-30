import { Sparkles } from 'lucide-react'

interface UpcomingSectionProps {
  title: string
  description?: string
  className?: string
}

/** 데이터가 아직 없는 미래 섹션 placeholder. 너무 비어 보이지 않도록 1줄 안내 */
export function UpcomingSection({ title, description, className = '' }: UpcomingSectionProps) {
  return (
    <section
      className={`rounded-xl border border-dashed border-zinc-200 bg-zinc-50/50 p-5 ${className}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-zinc-400">
          <Sparkles className="size-4" />
        </div>
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-zinc-700">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {description ?? '곧 추가될 예정입니다'}
          </p>
        </div>
      </div>
    </section>
  )
}
