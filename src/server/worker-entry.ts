/**
 * Custom Worker entry point
 *
 * TanStack Start의 fetch 핸들러를 그대로 사용하면서
 * Cloudflare Workers Cron용 scheduled 핸들러를 추가.
 */

import { createStartHandler, defaultRenderHandler } from '@tanstack/react-start/server'
import { NodeHtmlMarkdown } from 'node-html-markdown'
import { processScoreRecomputeMessages, type ScoreRecomputeMessage } from './queues/score-recompute'
import {
  markSourceFilterTerminal,
  processSourceFilterMessages,
  type SourceFilterMessage,
  TERMINAL_ATTEMPT,
} from './queues/source-filter'
import { handleDdgScheduled, handleLotSummaryScheduled, handleScheduled } from './scheduled'

interface Env {
  DB: D1Database
  SCORE_RECOMPUTE_QUEUE: Queue<ScoreRecomputeMessage>
  SOURCE_FILTER_QUEUE: Queue<SourceFilterMessage>
  NAVER_CLIENT_ID: string
  NAVER_CLIENT_SECRET: string
  YOUTUBE_API_KEY: string
  BRAVE_SEARCH_API_KEY: string
  CRAWL4AI_URL: string
  UNSLOTH_API_KEY: string
  AI_MODEL?: string
  AI_BASE_URL?: string
}

const startHandler = createStartHandler(defaultRenderHandler)

const API_CATALOG_PROFILE = 'https://www.rfc-editor.org/info/rfc9727'
const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8'

const HOMEPAGE_DISCOVERY_LINKS = [
  `</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"; profile="${API_CATALOG_PROFILE}"`,
  '</docs/api>; rel="service-doc"; type="text/html"',
]

function buildDiscoveryResponse(
  body: BodyInit | null,
  contentType: string,
  extraHeaders?: HeadersInit,
) {
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      ...extraHeaders,
    },
  })
}

function buildApiCatalogDocument(request: Request) {
  const apiCatalogUrl = new URL('/.well-known/api-catalog', request.url).toString()
  const apiDiscoveryUrl = new URL('/api/discovery', request.url).toString()
  const apiDocsUrl = new URL('/docs/api', request.url).toString()

  return {
    linkset: [
      {
        anchor: apiCatalogUrl,
        item: [
          {
            href: apiDiscoveryUrl,
            type: 'application/json',
          },
        ],
        'service-doc': [
          {
            href: apiDocsUrl,
            type: 'text/html',
          },
        ],
      },
    ],
  }
}

function buildApiDocsHtml(request: Request) {
  const origin = new URL(request.url).origin

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>easy-parking.xyz API docs</title>
  </head>
  <body>
    <main>
      <h1>easy-parking.xyz API docs</h1>
      <p>This site exposes lightweight machine-readable discovery metadata for agents.</p>
      <ul>
        <li><code>GET ${origin}/.well-known/api-catalog</code> returns the RFC 9727 API catalog in <code>application/linkset+json</code>.</li>
        <li><code>GET ${origin}/api/discovery</code> returns a compact JSON document describing the currently advertised public API surface.</li>
        <li><code>/api/auth/*</code> is reserved for Better Auth handlers used by the web application.</li>
      </ul>
    </main>
  </body>
</html>`
}

function buildApiDiscoveryDocument(request: Request) {
  const origin = new URL(request.url).origin

  return {
    service: {
      name: 'easy-parking.xyz',
      description: 'Nationwide parking difficulty map and related service discovery metadata.',
    },
    docs: `${origin}/docs/api`,
    apiCatalog: `${origin}/.well-known/api-catalog`,
    endpoints: [
      {
        path: '/api/discovery',
        methods: ['GET', 'HEAD'],
        contentType: 'application/json',
        description: 'Machine-readable service discovery document for agents and integrations.',
      },
      {
        path: '/api/auth/*',
        methods: ['GET', 'POST'],
        description: 'Authentication endpoints used by the first-party web app.',
      },
    ],
  }
}

function requestAcceptsMarkdown(request: Request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false
  }

  const accept = request.headers.get('Accept')?.toLowerCase() ?? ''
  return accept.includes('text/markdown')
}

function appendVaryHeader(headers: Headers, value: string) {
  const existing = headers.get('Vary')
  if (!existing) {
    headers.set('Vary', value)
    return
  }

  const values = existing
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)

  if (!values.includes(value.toLowerCase())) {
    headers.set('Vary', `${existing}, ${value}`)
  }
}

function estimateMarkdownTokens(markdown: string) {
  return Math.max(1, Math.ceil(markdown.length / 4))
}

async function convertHtmlResponseToMarkdown(response: Response) {
  const html = await response.text()
  const markdown = NodeHtmlMarkdown.translate(html)
  const headers = new Headers(response.headers)

  headers.set('Content-Type', MARKDOWN_CONTENT_TYPE)
  headers.set('x-markdown-tokens', String(estimateMarkdownTokens(markdown)))
  headers.delete('Content-Length')
  appendVaryHeader(headers, 'Accept')

  return new Response(markdown, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export async function withMarkdownNegotiation(request: Request, response: Response) {
  const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? ''

  if (!contentType.startsWith('text/html')) {
    return response
  }

  const headers = new Headers(response.headers)
  appendVaryHeader(headers, 'Accept')

  if (!requestAcceptsMarkdown(request)) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  if (request.method === 'HEAD') {
    headers.set('Content-Type', MARKDOWN_CONTENT_TYPE)
    headers.delete('Content-Length')
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  return convertHtmlResponseToMarkdown(
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  )
}

export function withHomepageDiscoveryHeaders(request: Request, response: Response) {
  if (new URL(request.url).pathname !== '/') {
    return response
  }

  const headers = new Headers(response.headers)
  for (const linkValue of HOMEPAGE_DISCOVERY_LINKS) {
    headers.append('Link', linkValue)
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url)

    // /__scheduled 경로로 수동 트리거 (dev/testing용)
    if (
      url.pathname === '/__scheduled' ||
      url.pathname === '/__scheduled/ddg' ||
      url.pathname === '/__scheduled/lot-summary'
    ) {
      const isDdg = url.pathname.includes('ddg')
      const isLotSummary = url.pathname.includes('lot-summary')
      const logs: string[] = []
      const origLog = console.log
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
        origLog(...args)
      }
      try {
        if (isLotSummary) await handleLotSummaryScheduled(env)
        else if (isDdg) await handleDdgScheduled(env)
        else await handleScheduled(env)
      } catch (err) {
        logs.push(`FATAL: ${(err as Error).message}`)
      }
      console.log = origLog
      return new Response(JSON.stringify({ ok: true, logs }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Sitemap: TanStack Start 서버 핸들러가 Content-Type을 text/html로 덮어쓰거나
    // 동적 라우트($id)가 404를 반환하는 문제 우회 — worker-entry에서 직접 처리
    if (url.pathname.match(/^\/sitemap(-\w+)?\.xml$/) || url.pathname.startsWith('/sitemap/')) {
      const { handleSitemap } = await import('./sitemap-handler')
      return handleSitemap(url.pathname, env.DB)
    }

    if (url.pathname === '/.well-known/api-catalog') {
      const body =
        request.method === 'HEAD' ? null : JSON.stringify(buildApiCatalogDocument(request), null, 2)

      return buildDiscoveryResponse(
        body,
        `application/linkset+json; profile="${API_CATALOG_PROFILE}"`,
        {
          Link: HOMEPAGE_DISCOVERY_LINKS[0],
        },
      )
    }

    if (url.pathname === '/docs/api') {
      const body = request.method === 'HEAD' ? null : buildApiDocsHtml(request)
      return withMarkdownNegotiation(
        request,
        buildDiscoveryResponse(body, 'text/html; charset=utf-8'),
      )
    }

    if (url.pathname === '/api/discovery') {
      const body =
        request.method === 'HEAD'
          ? null
          : JSON.stringify(buildApiDiscoveryDocument(request), null, 2)

      return buildDiscoveryResponse(body, 'application/json; charset=utf-8')
    }

    const response = await startHandler(request, env)
    const discoveredResponse = withHomepageDiscoveryHeaders(request, response)
    return withMarkdownNegotiation(request, discoveredResponse)
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // 2시간마다 0분: 메인 파이프라인 (naver, youtube, brave, AI필터, 매칭, 스코어링)
    // 2시간마다 30분: DDG 크롤링 (별도 subrequest 한도)
    // 매시 45분: 종합 요약 (별도 wall time)
    //
    // ⚠️ cron 문자열 전체 비교는 하지 않는다. 예전에 `'30 */1 * * *'` 와 정확히 비교했는데
    //    2026-08-19 에 주기를 매시→2시간(`30 */2 * * *`)으로 바꾸면서 이 줄을 놓쳤다.
    //    조건이 영원히 거짓이 되어 :30 트리거가 else 로 떨어졌고, DDG 는 한 번도 돌지 않은 채
    //    메인 파이프라인만 두 번 돌았다 (2026-09-03 실측: 7일간 ddg 유입 0건).
    //    분(minute) 필드만 본다 — 주기를 바꿔도 라우팅은 그대로 맞는다.
    const minute = controller.cron.split(' ')[0]
    if (minute === '45') {
      ctx.waitUntil(handleLotSummaryScheduled(env))
    } else if (minute === '30') {
      ctx.waitUntil(handleDdgScheduled(env))
    } else {
      ctx.waitUntil(handleScheduled(env))
    }
  },
  async queue(
    batch: MessageBatch<ScoreRecomputeMessage | SourceFilterMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    // 큐마다 소비자를 나눈다. 실패 처리 방식이 다르기 때문이다 —
    // 재계산은 다음 회차가 어차피 다시 줍지만, 필터는 그 행이 영영 안 넘어간다.
    if (batch.queue === 'source-filter-queue') {
      const messages = batch.messages as Message<SourceFilterMessage>[]
      try {
        const result = await processSourceFilterMessages(
          env.DB,
          messages.map((message) => message.body),
        )
        console.log(
          `[source-filter-queue] ${result.filtered}/${result.requested} filtered (${result.passed} passed, ${result.removed} removed)`,
        )
        for (const message of messages) message.ack()
      } catch (err) {
        // 처리는 멱등(`ai_filtered_at IS NULL`)이라 일부가 이미 반영됐어도 두 번 쓰지 않는다.
        //
        // 다만 무한정 재시도하면 안 된다. 생산자 조회 조건이 `ai_filtered_at IS NULL` 이라
        // DLQ 로 간 행도 두 시간 뒤 다시 큐에 들어온다. 마지막 시도까지 실패한 행은
        // 종결 표시해 그 고리를 끊는다.
        const exhausted = messages.filter((m) => m.attempts >= TERMINAL_ATTEMPT)
        const retryable = messages.filter((m) => m.attempts < TERMINAL_ATTEMPT)
        console.error(
          `[source-filter-queue] batch failed (retry ${retryable.length}, terminal ${exhausted.length})`,
          err,
        )
        if (exhausted.length > 0) {
          try {
            await markSourceFilterTerminal(
              env.DB,
              exhausted.map((m) => m.body.rawId),
            )
            for (const message of exhausted) message.ack()
          } catch (markErr) {
            console.error('[source-filter-queue] terminal mark failed', markErr)
            for (const message of exhausted) message.retry()
          }
        }
        for (const message of retryable) message.retry()
      }
      return
    }

    if (batch.queue !== 'score-recompute-queue') return

    const result = await processScoreRecomputeMessages(
      env.DB,
      (batch.messages as Message<ScoreRecomputeMessage>[]).map((message) => message.body),
    )
    console.log(
      `[score-recompute-queue] ${result.updated}/${result.lotIds.length} lots recomputed from ${result.messageCount} messages (summary stale +${result.staleMarked})`,
    )

    for (const message of batch.messages) {
      message.ack()
    }
  },
}
