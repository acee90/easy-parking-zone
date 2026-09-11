import { NavigationButton } from '@/components/NavigationButton'

interface ParkingActionGroupProps {
  lat: number
  lng: number
  name: string
  /** 있으면 길찾기 시 기억해 두었다가 다음 방문에 별점을 묻는다 (A-6) */
  lotId?: string
  navigationButtonClassName?: string
}

/**
 * 주차장 액션 행. 현재는 길찾기 버튼 하나뿐이지만,
 * 5개 화면이 같은 자리를 공유하므로 슬롯으로 유지한다.
 */
export function ParkingActionGroup({
  lat,
  lng,
  name,
  lotId,
  navigationButtonClassName,
}: ParkingActionGroupProps) {
  return (
    <div className="flex items-center gap-2">
      <NavigationButton
        lat={lat}
        lng={lng}
        name={name}
        lotId={lotId}
        wrapperClassName="min-w-0 flex-1"
        buttonClassName={`w-full ${navigationButtonClassName ?? ''}`}
      />
    </div>
  )
}
