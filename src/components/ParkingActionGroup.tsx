import { NavigationButton } from '@/components/NavigationButton'

interface ParkingActionGroupProps {
  lat: number
  lng: number
  name: string
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
  navigationButtonClassName,
}: ParkingActionGroupProps) {
  return (
    <div className="flex items-center gap-2">
      <NavigationButton
        lat={lat}
        lng={lng}
        name={name}
        wrapperClassName="min-w-0 flex-1"
        buttonClassName={`w-full ${navigationButtonClassName ?? ''}`}
      />
    </div>
  )
}
