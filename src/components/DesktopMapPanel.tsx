import { ChevronLeft, ParkingSquare } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect } from 'react'
import { ParkingDetailPanel } from '@/components/ParkingDetailPanel'
import { ParkingSidebar } from '@/components/ParkingSidebar'
import type { ParkingLot } from '@/types/parking'

interface DesktopMapPanelProps {
  parkingLots: ParkingLot[]
  selectedLot: ParkingLot | null
  viewMode: 'list' | 'detail'
  hoveredLotId: string | null
  onSelect: (lot: ParkingLot) => void
  onHover: (id: string | null) => void
  onCloseDetail: () => void
  userLat?: number
  userLng?: number
  userLocated?: boolean
  mapCenter?: { lat: number; lng: number } | null
}

const SLIDE_DURATION = 0.25
const HEADER_FADE_DURATION = 0.15
const SLIDE_EASE = [0.16, 1, 0.3, 1] as const

export function DesktopMapPanel({
  parkingLots,
  selectedLot,
  viewMode,
  hoveredLotId,
  onSelect,
  onHover,
  onCloseDetail,
  userLat,
  userLng,
  userLocated,
  mapCenter,
}: DesktopMapPanelProps) {
  const reduced = useReducedMotion()
  const slideDur = reduced ? 0 : SLIDE_DURATION
  const fadeDur = reduced ? 0 : HEADER_FADE_DURATION
  const showDetail = viewMode === 'detail' && selectedLot !== null

  // ESC로 detail에서 list로 pop
  useEffect(() => {
    if (!showDetail) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseDetail()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showDetail, onCloseDetail])

  return (
    <aside
      className="flex flex-col w-[360px] h-full overflow-hidden rounded-xl shadow-lg border bg-white/95 backdrop-blur-sm pointer-events-auto"
      aria-label="주차장 패널"
    >
      {/* Persistent header — 슬라이드되지 않음 */}
      <header className="shrink-0 h-12 px-3 flex items-center border-b bg-white relative">
        <AnimatePresence mode="wait" initial={false}>
          {showDetail ? (
            <motion.div
              key="detail-header"
              className="absolute inset-0 px-3 flex items-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: fadeDur }}
            >
              <button
                type="button"
                onClick={onCloseDetail}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-gray-100 transition-colors cursor-pointer"
                aria-label="목록으로 돌아가기"
              >
                <ChevronLeft className="size-4" />
                목록
              </button>
            </motion.div>
          ) : (
            <motion.div
              key="list-header"
              className="absolute inset-0 px-4 flex items-center justify-between"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: fadeDur }}
            >
              <div className="flex items-center gap-2">
                <ParkingSquare className="size-4 text-blue-500" />
                <span className="font-semibold text-base">주차장 목록</span>
              </div>
              <span className="text-sm text-muted-foreground">{parkingLots.length}개</span>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* 슬라이드되는 body */}
      <div className="relative flex-1 overflow-hidden">
        <AnimatePresence mode="sync" initial={false}>
          {showDetail && selectedLot ? (
            <motion.div
              key="detail"
              className="absolute inset-0"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: slideDur, ease: SLIDE_EASE }}
            >
              <ParkingDetailPanel
                lot={selectedLot}
                userLat={userLat}
                userLng={userLng}
                userLocated={userLocated}
              />
            </motion.div>
          ) : (
            <motion.div
              key="list"
              className="absolute inset-0"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: slideDur, ease: SLIDE_EASE }}
            >
              <ParkingSidebar
                parkingLots={parkingLots}
                selectedLotId={selectedLot?.id ?? null}
                hoveredLotId={hoveredLotId}
                onSelect={onSelect}
                onHover={onHover}
                userLat={userLat}
                userLng={userLng}
                userLocated={userLocated}
                mapCenter={mapCenter}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </aside>
  )
}
