import { describe, expect, it } from 'vitest'
import { withHomepageDiscoveryHeaders, withMarkdownNegotiation } from './worker-entry'

describe('withHomepageDiscoveryHeaders', () => {
  it('appends agent discovery Link headers on the homepage', () => {
    const request = new Request('https://easy-parking.xyz/')
    const response = withHomepageDiscoveryHeaders(
      request,
      new Response('<html></html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    )

    const links = response.headers.get('Link')

    expect(links).toContain('</.well-known/api-catalog>; rel="api-catalog"')
    expect(links).toContain('</docs/api>; rel="service-doc"')
  })

  it('leaves non-homepage responses unchanged', () => {
    const request = new Request('https://easy-parking.xyz/wiki')
    const response = withHomepageDiscoveryHeaders(request, new Response('ok'))

    expect(response.headers.get('Link')).toBeNull()
  })
})

describe('withMarkdownNegotiation', () => {
  it('returns markdown for html responses when requested by agents', async () => {
    const request = new Request('https://easy-parking.xyz/', {
      headers: { Accept: 'text/markdown' },
    })
    const response = await withMarkdownNegotiation(
      request,
      new Response('<html><body><h1>Hello</h1><p>World</p></body></html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    )

    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')
    expect(response.headers.get('Vary')).toContain('Accept')
    expect(response.headers.get('x-markdown-tokens')).not.toBeNull()
    await expect(response.text()).resolves.toContain('# Hello')
  })

  it('keeps html as the default for browsers while advertising Accept variance', async () => {
    const request = new Request('https://easy-parking.xyz/')
    const response = await withMarkdownNegotiation(
      request,
      new Response('<html><body><h1>Hello</h1></body></html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    )

    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('Vary')).toContain('Accept')
    await expect(response.text()).resolves.toContain('<h1>Hello</h1>')
  })
})
