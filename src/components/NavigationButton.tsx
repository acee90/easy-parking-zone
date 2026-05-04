import { ChevronDown, Navigation } from 'lucide-react'
import type { ReactNode, SVGProps } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getNavOptions, type NavApp } from '@/lib/navigation'

interface NavigationButtonProps {
  lat: number
  lng: number
  name: string
  buttonClassName?: string
  wrapperClassName?: string
}

function NaverMapIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <rect width="24" height="24" rx="7" fill="#03C75A" />
      <path d="M6.6 6.2h4.1l3.7 5.4V6.2h3.1v11.6h-3.7l-4.1-6v6H6.6V6.2Z" fill="white" />
    </svg>
  )
}

function KakaoMapIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <rect width="24" height="24" rx="7" fill="#FEE500" />
      <path
        d="M12 5.6c-4.2 0-7.6 2.6-7.6 5.8 0 2.1 1.5 4 3.8 5L7.4 19c-.1.3.2.5.5.3l3.1-2.1h1c4.2 0 7.6-2.6 7.6-5.8S16.2 5.6 12 5.6Z"
        fill="#191919"
      />
    </svg>
  )
}

function TmapIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <rect width="24" height="24" rx="7" fill="#0B5CFF" />
      <path d="M6 6.2h12v3H13.7v8.6h-3.4V9.2H6v-3Z" fill="white" />
    </svg>
  )
}

const APP_ICONS: Record<NavApp, (props: SVGProps<SVGSVGElement>) => ReactNode> = {
  naver: NaverMapIcon,
  kakao: KakaoMapIcon,
  tmap: TmapIcon,
}

export function NavigationButton({
  lat,
  lng,
  name,
  buttonClassName,
  wrapperClassName,
}: NavigationButtonProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent | TouchEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') setOpen(false)
        return
      }
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler as EventListener)
    document.addEventListener('touchstart', handler as EventListener)
    document.addEventListener('keydown', handler as EventListener)
    return () => {
      document.removeEventListener('mousedown', handler as EventListener)
      document.removeEventListener('touchstart', handler as EventListener)
      document.removeEventListener('keydown', handler as EventListener)
    }
  }, [open])

  // 클라이언트에서만 URL 생성 (SSR hydration mismatch 방지)
  const options = useMemo(
    () => (open ? getNavOptions({ lat, lng, name }) : []),
    [open, lat, lng, name],
  )

  return (
    <div ref={ref} className={`relative ${wrapperClassName ?? ''}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className={`inline-grid h-10 min-w-[132px] grid-cols-[auto_1fr_auto] items-center gap-2 rounded-full bg-blue-500 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-600 active:bg-blue-700 cursor-pointer ${buttonClassName ?? ''}`}
      >
        <Navigation className="size-4" />
        <span className="text-center">길찾기</span>
        <ChevronDown className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 z-50 w-full min-w-[180px] rounded-xl border bg-white p-1 shadow-lg"
        >
          {options.map((opt) => {
            const AppIcon = APP_ICONS[opt.app]
            return (
              <a
                key={opt.app}
                role="menuitem"
                href={opt.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className="flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50"
              >
                <AppIcon className="size-6 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{opt.label}</span>
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}
