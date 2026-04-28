import { createFileRoute } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/admin/tools')({
  component: AdminToolsPage,
})

function AdminToolsPage() {
  const [sitemapStatus, setSitemapStatus] = useState<'idle' | 'loading' | 'success' | 'error'>(
    'idle',
  )
  const [sitemapMessage, setSitemapMessage] = useState('')

  const testSitemap = async () => {
    setSitemapStatus('loading')
    setSitemapMessage('')

    try {
      const response = await fetch('/sitemap-test.xml')
      if (!response.ok) {
        setSitemapStatus('error')
        setSitemapMessage(`HTTP ${response.status}: ${response.statusText}`)
        return
      }

      const contentType = response.headers.get('content-type') || ''
      const text = await response.text()

      if (!contentType.includes('application/xml')) {
        setSitemapStatus('error')
        setSitemapMessage(`잘못된 Content-Type: ${contentType}`)
        return
      }

      const parser = new DOMParser()
      const doc = parser.parseFromString(text, 'application/xml')

      if (doc.getElementsByTagName('parsererror').length > 0) {
        setSitemapStatus('error')
        setSitemapMessage('XML 파싱 실패')
        return
      }

      const urls = doc.getElementsByTagName('url')
      setSitemapStatus('success')
      setSitemapMessage(`✓ 사이트맵 정상 (Content-Type: ${contentType}, URLs: ${urls.length}개)`)
    } catch (err) {
      setSitemapStatus('error')
      setSitemapMessage(`오류: ${err instanceof Error ? err.message : '알 수 없는 오류'}`)
    }
  }

  const statusColors = {
    idle: 'text-gray-500',
    loading: 'text-blue-600',
    success: 'text-green-600',
    error: 'text-red-600',
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold">사이트 도구</h2>

      {/* Sitemap Test */}
      <div className="bg-white rounded-lg border p-6">
        <div className="space-y-4">
          <div>
            <h3 className="font-semibold text-base mb-1">사이트맵 검증</h3>
            <p className="text-sm text-gray-600">
              배포된 사이트맵이 올바른 형식과 헤더를 반환하는지 테스트합니다
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <Button onClick={testSitemap} disabled={sitemapStatus === 'loading'}>
              {sitemapStatus === 'loading' ? '테스트 중...' : '사이트맵 테스트'}
            </Button>

            {sitemapMessage && (
              <div className={`text-sm font-medium ${statusColors[sitemapStatus]}`}>
                {sitemapMessage}
              </div>
            )}

            <div className="text-xs text-gray-500 space-y-1">
              <p>
                • <code>/sitemap-main.xml</code> 인덱스 — 모든 주차장 사이트맵 링크
              </p>
              <p>
                • <code>/sitemap-static.xml</code> — 홈, 위키 등 정적 페이지
              </p>
              <p>
                • <code>/sitemap-N.xml</code> — 주차장 (0~N 페이지, 각 5000개)
              </p>
              <p>
                • <code>/sitemap-test.xml</code> — 테스트 (상위 10개 주차장)
              </p>
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <a
              href="https://search.google.com/search-console"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 hover:underline flex items-center gap-1"
            >
              Google Search Console <ExternalLink className="w-3 h-3" />
            </a>
            <a
              href="https://www.bing.com/webmasters"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 hover:underline flex items-center gap-1"
            >
              Bing Webmaster Tools <ExternalLink className="w-3 h-3" />
            </a>
            <a
              href="https://www.xml-sitemaps.com/validate-xml-sitemap.html"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 hover:underline flex items-center gap-1"
            >
              Online Sitemap Validator <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>

      {/* Robots.txt Info */}
      <div className="bg-white rounded-lg border p-6">
        <div className="space-y-3">
          <h3 className="font-semibold text-base">robots.txt</h3>
          <div className="bg-gray-50 rounded p-3 text-xs font-mono text-gray-700 overflow-auto">
            <pre>{`User-agent: *
Allow: /
Disallow: /admin/

Sitemap: https://easy-parking.xyz/sitemap-main.xml`}</pre>
          </div>
        </div>
      </div>
    </div>
  )
}
