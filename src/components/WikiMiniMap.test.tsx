import { act, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WikiMiniMap } from './WikiMiniMap'

const { loadNaverMapSdkMock } = vi.hoisted(() => ({
  loadNaverMapSdkMock: vi.fn(),
}))

vi.mock('@/lib/naver-map-sdk', () => ({
  loadNaverMapSdk: loadNaverMapSdkMock,
}))

vi.mock('react-naver-maps', () => {
  class FakeLatLng {
    constructor(
      public lat: number,
      public lng: number,
    ) {}
  }

  return {
    Container: ({ children }: { children?: ReactNode }) => (
      <div data-testid="mini-map">{children}</div>
    ),
    Marker: () => <div data-testid="mini-map-marker" />,
    NaverMap: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    NavermapsProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
    useNavermaps: () => ({ LatLng: FakeLatLng }),
  }
})

const LOT = { lat: 37.5, lng: 127 }

/** 주차장에서 정북으로 distanceM 떨어진 좌표 (위도 1도 ≈ 111,320m) */
function northOfLot(distanceM: number) {
  return { lat: LOT.lat + distanceM / 111_320, lng: LOT.lng }
}

interface FakeLocation {
  panoId?: string
  photodate?: string
  coord: { lat: () => number; lng: () => number }
}

function fakeLocation(panoId: string, distanceM: number, photodate: string): FakeLocation {
  const { lat, lng } = northOfLot(distanceM)
  return { panoId, photodate, coord: { lat: () => lat, lng: () => lng } }
}

describe('WikiMiniMap', () => {
  const roadviewHandlers: Array<(status: string) => void> = []
  interface FakePanoramaLike {
    isProbe: boolean
    handlers: Array<(status: string) => void>
    setPov: ReturnType<typeof vi.fn>
    setPanoId: ReturnType<typeof vi.fn>
    setPosition: ReturnType<typeof vi.fn>
    getLocation: ReturnType<typeof vi.fn>
  }
  const panoramaInstances: FakePanoramaLike[] = []
  /** 표시용 파노라마가 돌려줄 위치. 기본값은 panoId 없음 → 후보 탐색을 타지 않는다. */
  let displayLocation: FakeLocation | null
  /** 프로브 인스턴스가 순서대로 돌려줄 응답 */
  let probeReplies: Array<{ status: string; location?: FakeLocation }>

  beforeEach(() => {
    roadviewHandlers.length = 0
    loadNaverMapSdkMock.mockReset()
    loadNaverMapSdkMock.mockResolvedValue(undefined)
    // 주차장(37.5, 127) 기준 남서쪽에 있는 파노라마 → 주차장은 북동(약 45도) 방향
    displayLocation = { coord: { lat: () => 37.499, lng: () => 126.9987 } }
    probeReplies = []

    class FakeLatLng {
      constructor(
        public lat: number,
        public lng: number,
      ) {}
    }

    class FakePanorama {
      // 패널은 표시용을 먼저 만들고, 필요할 때만 프로브용을 추가로 만든다.
      isProbe = panoramaInstances.length > 0
      handlers: Array<(status: string) => void> = []
      location: FakeLocation | null = null
      setVisible = vi.fn()
      setPov = vi.fn()
      setPanoId = vi.fn()
      setPosition = vi.fn(() => this.replyNext())
      getLocation = vi.fn(() => (this.isProbe ? this.location : displayLocation))

      constructor() {
        if (this.isProbe) this.replyNext()
      }

      /** 실제 SDK처럼 비동기로 pano_status를 흘린다. 실패 시 직전 위치를 그대로 둔다. */
      replyNext() {
        queueMicrotask(() => {
          const reply = probeReplies.shift() ?? { status: 'ERROR' }
          if (reply.status === 'OK' && reply.location) this.location = reply.location
          for (const handler of this.handlers) handler(reply.status)
        })
      }
    }
    panoramaInstances.length = 0
    const PanoramaSpy = new Proxy(FakePanorama, {
      construct(target, args) {
        const instance = Reflect.construct(target, args)
        panoramaInstances.push(instance)
        return instance
      },
    })

    const maps = {
      Event: {
        addListener: vi.fn(
          (target: object, _eventName: string, handler: (status: string) => void) => {
            const instance = target as FakePanoramaLike
            instance.handlers.push(handler)
            // 표시용 파노라마의 핸들러만 테스트에서 직접 호출한다.
            if (!instance.isProbe) roadviewHandlers.push(handler)
            return handler
          },
        ),
        removeListener: vi.fn(),
      },
      LatLng: FakeLatLng,
      Panorama: PanoramaSpy,
    }

    Object.defineProperty(window, 'naver', {
      configurable: true,
      value: { maps },
    })
  })

  /** 로드뷰 탭을 열고 표시용 파노라마의 pano_status 리스너가 붙을 때까지 기다린다 */
  async function openRoadview() {
    render(<WikiMiniMap lat={LOT.lat} lng={LOT.lng} name="테스트 주차장" />)
    await waitFor(() => expect(screen.getByRole('tab', { name: '로드뷰' })).toBeTruthy())
    await act(async () => {
      screen.getByRole('tab', { name: '로드뷰' }).click()
    })
    await waitFor(() => expect(roadviewHandlers).toHaveLength(1))
  }

  it('renders the map by default and does not request panorama until selected', async () => {
    render(<WikiMiniMap lat={37.5} lng={127} name="테스트 주차장" />)

    await waitFor(() => expect(screen.getByTestId('mini-map')).toBeTruthy())
    expect(screen.getByTestId('mini-map-marker')).toBeTruthy()
    expect(loadNaverMapSdkMock).toHaveBeenCalledTimes(1)
    expect(loadNaverMapSdkMock.mock.calls[0]?.[1]).toBeUndefined()
  })

  it('loads panorama lazily and shows an unavailable state when no roadview exists', async () => {
    render(<WikiMiniMap lat={37.5} lng={127} name="테스트 주차장" />)

    await waitFor(() => expect(screen.getByRole('tab', { name: '로드뷰' })).toBeTruthy())
    await act(async () => {
      screen.getByRole('tab', { name: '로드뷰' }).click()
    })

    await waitFor(() => expect(loadNaverMapSdkMock).toHaveBeenCalledTimes(2))
    expect(loadNaverMapSdkMock.mock.calls[1]?.[1]).toEqual({ submodules: ['panorama'] })

    await waitFor(() => expect(roadviewHandlers).toHaveLength(1))
    act(() => roadviewHandlers[0]?.('ERROR'))

    expect(await screen.findByText('이 위치에는 표시할 로드뷰가 없습니다')).toBeTruthy()
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy()
  })

  // 파노라마는 주차장에서 수십 m 떨어진 도로 위에 잡힌다. pan=0(정북) 고정이면
  // 주차장이 화면 밖으로 나가므로, 실제 파노라마 좌표 기준 방위각으로 돌려줘야 한다.
  it('로드뷰가 뜨면 주차장 방향으로 시야를 보정한다', async () => {
    render(<WikiMiniMap lat={37.5} lng={127} name="테스트 주차장" />)

    await waitFor(() => expect(screen.getByRole('tab', { name: '로드뷰' })).toBeTruthy())
    await act(async () => {
      screen.getByRole('tab', { name: '로드뷰' }).click()
    })
    await waitFor(() => expect(roadviewHandlers).toHaveLength(1))
    act(() => roadviewHandlers[0]?.('OK'))

    const panorama = panoramaInstances.at(-1)
    expect(panorama?.setPov).toHaveBeenCalledTimes(1)
    const pov = panorama?.setPov.mock.calls[0]?.[0]
    // 파노라마가 남서쪽에 있으므로 주차장은 북동(≈45도) 방향
    expect(pov.pan).toBeGreaterThan(30)
    expect(pov.pan).toBeLessThan(60)
    expect(pov.tilt).toBe(0)
  })

  it('로드뷰가 없으면 시야 보정을 시도하지 않는다', async () => {
    render(<WikiMiniMap lat={37.5} lng={127} name="테스트 주차장" />)

    await waitFor(() => expect(screen.getByRole('tab', { name: '로드뷰' })).toBeTruthy())
    await act(async () => {
      screen.getByRole('tab', { name: '로드뷰' }).click()
    })
    await waitFor(() => expect(roadviewHandlers).toHaveLength(1))
    act(() => roadviewHandlers[0]?.('ERROR'))

    expect(panoramaInstances.at(-1)?.setPov).not.toHaveBeenCalled()
  })

  it('파노라마 좌표를 얻지 못해도 로드뷰는 정상 표시한다', async () => {
    render(<WikiMiniMap lat={37.5} lng={127} name="테스트 주차장" />)

    await waitFor(() => expect(screen.getByRole('tab', { name: '로드뷰' })).toBeTruthy())
    await act(async () => {
      screen.getByRole('tab', { name: '로드뷰' }).click()
    })
    await waitFor(() => expect(roadviewHandlers).toHaveLength(1))

    const panorama = panoramaInstances.at(-1)
    panorama?.getLocation.mockReturnValueOnce(null)
    act(() => roadviewHandlers[0]?.('OK'))

    expect(panorama?.setPov).not.toHaveBeenCalled()
    expect(screen.queryByText('로드뷰를 불러오지 못했습니다')).toBeNull()
  })

  // 대다수 주차장이 이 경우다. 이미 주차장 앞이면 프로브는 낭비다.
  it('최근접 파노라마가 가드 안이면 후보를 탐색하지 않는다', async () => {
    displayLocation = fakeLocation('near', 12, '2025-01-22')
    await openRoadview()

    await act(async () => {
      roadviewHandlers[0]?.('OK')
    })

    expect(panoramaInstances).toHaveLength(1)
    expect(panoramaInstances[0]?.setPanoId).not.toHaveBeenCalled()
  })

  // 이마트 월계점 패턴: 56m 뒷골목 대신 86m 정문을 골라야 한다.
  it('최근접이 멀면 후보를 탐색해 촬영일이 최신인 파노라마로 바꾼다', async () => {
    displayLocation = fakeLocation('back-alley', 56, '2025-01-22')
    probeReplies = [{ status: 'OK', location: fakeLocation('front-gate', 86, '2026-02-23') }]
    await openRoadview()

    await act(async () => {
      roadviewHandlers[0]?.('OK')
    })

    const display = panoramaInstances[0]
    await waitFor(() => expect(display?.setPanoId).toHaveBeenCalledWith('front-gate'))
    // 교체한 파노라마 기준으로 시야도 다시 맞춘다 — 정문은 남쪽(180도)에 있다.
    const lastPov = display?.setPov.mock.calls.at(-1)?.[0]
    expect(lastPov.pan).toBeCloseTo(180, 0)
  })

  it('후보 탐색 중 사용자가 로드뷰를 조작하면 화면을 바꾸지 않는다', async () => {
    displayLocation = fakeLocation('back-alley', 56, '2025-01-22')
    probeReplies = [{ status: 'OK', location: fakeLocation('front-gate', 86, '2026-02-23') }]
    await openRoadview()

    await act(async () => {
      roadviewHandlers[0]?.('OK')
      // 프로브가 첫 응답을 받기 전(마이크로태스크 실행 전)에 사용자가 시야를 잡는다.
      document
        .getElementById('parking-location-roadview')
        ?.firstElementChild?.dispatchEvent(new Event('pointerdown'))
    })

    await waitFor(() => expect(panoramaInstances).toHaveLength(2))
    await act(async () => {})
    expect(panoramaInstances[0]?.setPanoId).not.toHaveBeenCalled()
  })

  it('후보를 하나도 못 찾으면 처음 잡힌 파노라마를 유지한다', async () => {
    displayLocation = fakeLocation('back-alley', 56, '2025-01-22')
    probeReplies = [] // 전부 ERROR
    await openRoadview()

    await act(async () => {
      roadviewHandlers[0]?.('OK')
    })

    await waitFor(() => expect(panoramaInstances).toHaveLength(2))
    await act(async () => {})
    expect(panoramaInstances[0]?.setPanoId).not.toHaveBeenCalled()
    expect(screen.queryByText('로드뷰를 불러오지 못했습니다')).toBeNull()
  })
})
