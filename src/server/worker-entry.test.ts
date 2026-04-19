import { describe, expect, it } from 'vitest'
import { withHomepageDiscoveryHeaders } from './worker-entry'

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
