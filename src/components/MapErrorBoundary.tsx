import { RefreshCw, TriangleAlert } from 'lucide-react'
import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class MapErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      const message = this.state.error?.message ?? '알 수 없는 오류'

      return (
        <div className="flex h-full w-full items-center justify-center bg-muted/30 p-8">
          <div className="flex max-w-md flex-col items-center gap-4 text-center">
            <TriangleAlert className="size-12 text-amber-500" />
            <h2 className="text-lg font-semibold">지도를 불러올 수 없습니다</h2>
            <p className="text-sm text-muted-foreground">{message}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-2 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <RefreshCw className="size-4" />
              새로고침
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
