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
  const dur = reduced ? 0 : SLIDE_DURATION
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
      className="relative w-[360px] h-full overflow-hidden rounded-xl shadow-lg border bg-white/95 backdrop-blur-sm pointer-events-auto"
      aria-label="주차장 패널"
    >
      <AnimatePresence mode="wait" initial={false}>
        {showDetail && selectedLot ? (
          <motion.div
            key="detail"
            className="absolute inset-0"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: dur, ease: SLIDE_EASE }}
          >
            <ParkingDetailPanel
              lot={selectedLot}
              onClose={onCloseDetail}
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
            transition={{ duration: dur, ease: SLIDE_EASE }}
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
    </aside>
  )
}
