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

describe('WikiMiniMap', () => {
  const roadviewHandlers: Array<(status: string) => void> = []
  const panoramaInstances: Array<{
    setPov: ReturnType<typeof vi.fn>
    getLocation: ReturnType<typeof vi.fn>
  }> = []

  beforeEach(() => {
    roadviewHandlers.length = 0
    loadNaverMapSdkMock.mockReset()
    loadNaverMapSdkMock.mockResolvedValue(undefined)

    class FakeLatLng {
      constructor(
        public lat: number,
        public lng: number,
      ) {}
    }

    class FakePanorama {
      setVisible = vi.fn()
      setPov = vi.fn()
      // 주차장(37.5, 127) 기준 남서쪽에 있는 파노라마 → 주차장은 북동(약 45도) 방향
      getLocation = vi.fn(() => ({
        coord: { lat: () => 37.499, lng: () => 126.9987 },
      }))
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
          (_target: object, _eventName: string, handler: (status: string) => void) => {
            roadviewHandlers.push(handler)
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
})
