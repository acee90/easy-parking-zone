import type { ReactNode } from 'react'

interface LegalShellProps {
  title: string
  updatedAt?: string
  children: ReactNode
}

/** 약관·방침·소개·문의 등 정적 문서 페이지 공통 레이아웃. */
export function LegalShell({ title, updatedAt, children }: LegalShellProps) {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <header className="mb-8 border-b pb-6">
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{title}</h1>
          {updatedAt && <p className="mt-2 text-sm text-muted-foreground">시행일 {updatedAt}</p>}
        </header>
        <article className="space-y-8 text-[15px] leading-relaxed text-gray-700">
          {children}
        </article>
      </div>
    </div>
  )
}

interface LegalSectionProps {
  heading: string
  children: ReactNode
}

export function LegalSection({ heading, children }: LegalSectionProps) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">{heading}</h2>
      {children}
    </section>
  )
}
