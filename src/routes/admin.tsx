import { createFileRoute, Link, Outlet, useMatches } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { authClient } from '@/lib/auth-client'
import { checkAdminAccess } from '@/server/admin'
import { fetchReportStats } from '@/server/admin-reports'

export const Route = createFileRoute('/admin')({
  component: AdminLayout,
})

const NAV_ITEMS = [
  { to: '/admin/web-sources', label: '웹 소스 관리' },
  { to: '/admin/reviews', label: '유저 리뷰 관리' },
  { to: '/admin/reports', label: '신고 관리' },
] as const

function AdminLayout() {
  const { data: session } = authClient.useSession()
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)
  const [pendingReports, setPendingReports] = useState(0)
  const matches = useMatches()
  const currentPath = matches[matches.length - 1]?.fullPath

  useEffect(() => {
    checkAdminAccess().then((r) => setIsAdmin(r.isAdmin))
  }, [])

  useEffect(() => {
    if (isAdmin) {
      fetchReportStats()
        .then((s) => setPendingReports(s.counts.pending ?? 0))
        .catch(() => {})
    }
  }, [isAdmin])

  if (isAdmin === null) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-gray-500">로딩 중...</p>
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-2xl font-bold mb-2">접근 권한 없음</p>
          <p className="text-gray-500">관리자만 접근할 수 있습니다.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-6">
            <h1 className="text-xl font-bold">쉬운주차장 Admin</h1>
            <nav className="flex gap-1">
              {NAV_ITEMS.map(({ to, label }) => (
                <Link
                  key={to}
                  to={to}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors relative ${
                    currentPath === to
                      ? 'bg-gray-900 text-white'
                      : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
                  }`}
                >
                  {label}
                  {to === '/admin/reports' && pendingReports > 0 && (
                    <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] text-[10px] font-bold bg-red-500 text-white rounded-full px-1">
                      {pendingReports}
                    </span>
                  )}
                </Link>
              ))}
            </nav>
          </div>
          <a href="/" className="text-sm text-blue-600 hover:underline">
            ← 서비스로 돌아가기
          </a>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        <Outlet />
      </main>
    </div>
  )
}
