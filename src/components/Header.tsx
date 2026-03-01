import { Car } from 'lucide-react'

export function Header() {
  return (
    <header className="shrink-0 flex items-center gap-3 border-b bg-white px-4 py-2.5 z-20">
      <div className="flex items-center gap-2 shrink-0">
        <Car className="size-5 text-blue-500" />
        <h1 className="font-bold text-base">쉬운주차</h1>
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>💀 쉬움</span>
        <span>💀💀 보통</span>
        <span>💀💀💀 주의</span>
        <span>💀💀💀💀 비추</span>
      </div>
    </header>
  )
}
