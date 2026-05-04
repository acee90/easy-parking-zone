import { NavigationButton } from '@/components/NavigationButton'
import { VoteBookmarkBar } from '@/components/VoteBookmarkBar'

interface ParkingActionGroupProps {
  lotId: string
  lat: number
  lng: number
  name: string
  navigationButtonClassName?: string
}

export function ParkingActionGroup({
  lotId,
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
      <VoteBookmarkBar lotId={lotId} />
    </div>
  )
}
