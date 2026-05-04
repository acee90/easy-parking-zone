import { ExternalLink } from 'lucide-react'

interface PublicDataAttributionProps {
  compact?: boolean
}

export function PublicDataAttribution({ compact = false }: PublicDataAttributionProps) {
  return (
    <p
      className={
        compact
          ? 'text-[11px] leading-tight text-muted-foreground'
          : 'border-t pt-3 text-xs leading-relaxed text-muted-foreground'
      }
    >
      주차장 기본 정보 출처:{' '}
      <a
        href="https://www.data.go.kr/"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
      >
        공공데이터포털
        <ExternalLink className="size-3" />
      </a>
    </p>
  )
}
