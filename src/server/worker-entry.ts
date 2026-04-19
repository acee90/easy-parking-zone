/**
 * Custom Worker entry point
 *
 * TanStack Start의 fetch 핸들러를 그대로 사용하면서
 * Cloudflare Workers Cron용 scheduled 핸들러를 추가.
 */
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { handleDdgScheduled, handleScheduled } from './scheduled'

interface Env {
  DB: D1Database
  NAVER_CLIENT_ID: string
  NAVER_CLIENT_SECRET: string
  YOUTUBE_API_KEY: string
  BRAVE_SEARCH_API_KEY: string
  CRAWL4AI_URL: string
  ANTHROPIC_API_KEY: string
}

const startHandler = createStartHandler(defaultStreamHandler)

const API_CATALOG_PROFILE = 'https://www.rfc-editor.org/info/rfc9727'

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

export function withHomepageDiscoveryHeaders(request: Request, response: Response) {
  if (new URL(request.url).pathname !== '/') {
    return response
  }

  const nextResponse = new Response(response.body, response)
  for (const linkValue of HOMEPAGE_DISCOVERY_LINKS) {
    nextResponse.headers.append('Link', linkValue)
  }

  return nextResponse
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url)

    // /__scheduled 경로로 수동 트리거 (dev/testing용)
    if (url.pathname === '/__scheduled' || url.pathname === '/__scheduled/ddg') {
      const isDdg = url.pathname.includes('ddg')
      const logs: string[] = []
      const origLog = console.log
      console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
        origLog(...args)
      }
      try {
        if (isDdg) await handleDdgScheduled(env)
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
      return buildDiscoveryResponse(body, 'text/html; charset=utf-8')
    }

    if (url.pathname === '/api/discovery') {
      const body =
        request.method === 'HEAD'
          ? null
          : JSON.stringify(buildApiDiscoveryDocument(request), null, 2)

      return buildDiscoveryResponse(body, 'application/json; charset=utf-8')
    }

    const response = await startHandler(request, env)
    return withHomepageDiscoveryHeaders(request, response)
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // 매시 0분: 메인 파이프라인 (naver, youtube, brave, AI필터, 매칭, 스코어링)
    // 매시 30분: DDG 크롤링 (별도 subrequest 한도)
    if (controller.cron === '30 */1 * * *') {
      ctx.waitUntil(handleDdgScheduled(env))
    } else {
      ctx.waitUntil(handleScheduled(env))
    }
  },
}
