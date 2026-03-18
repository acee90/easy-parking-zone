import { useState, useRef, useEffect, useMemo } from "react";
import { Navigation } from "lucide-react";
import { getNavOptions, type NavApp } from "@/lib/navigation";

interface NavigationButtonProps {
  lat: number;
  lng: number;
  name: string;
}

const APP_ICONS: Record<NavApp, string> = {
  naver: "🟢",
  kakao: "🟡",
  tmap: "🔵",
};

export function NavigationButton({ lat, lng, name }: NavigationButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent | TouchEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setOpen(false);
        return;
      }
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler as EventListener);
    document.addEventListener("touchstart", handler as EventListener);
    document.addEventListener("keydown", handler as EventListener);
    return () => {
      document.removeEventListener("mousedown", handler as EventListener);
      document.removeEventListener("touchstart", handler as EventListener);
      document.removeEventListener("keydown", handler as EventListener);
    };
  }, [open]);

  // 클라이언트에서만 URL 생성 (SSR hydration mismatch 방지)
  const options = useMemo(
    () => (open ? getNavOptions({ lat, lng, name }) : []),
    [open, lat, lng, name],
  );

  return (
    <div ref={ref} className="relative">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 active:bg-blue-700 transition-colors cursor-pointer"
      >
        <Navigation className="size-3" />
        길찾기
      </button>

      {open && (
        <div role="menu" className="absolute left-0 top-full mt-1 z-50 rounded-lg border bg-white shadow-lg py-1 min-w-[140px]">
          {options.map((opt) => (
            <a
              key={opt.app}
              role="menuitem"
              href={opt.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 transition-colors"
            >
              <span>{APP_ICONS[opt.app]}</span>
              <span>{opt.label}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
