import { Loader2 } from 'lucide-react'

export function LoadingState() {
  return (
    <div className="flex items-center justify-center gap-1.5 py-6">
      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
      <span className="text-sm text-muted-foreground">불러오는 중...</span>
    </div>
  )
}
