/**
 * 서버 함수 결과를 Workers Cache API 에 JSON 으로 둔다.
 * 캐시가 없는 환경(테스트 등)에서는 매번 load 를 부른다. 캐시 읽기·쓰기 실패는 무시한다.
 */
export async function cachedJson<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const cache = typeof caches !== 'undefined' ? await caches.open('page-data') : null
  const url = `https://easy-parking.xyz/__internal/${key}`
  const hit = await cache?.match(url).catch(() => undefined)
  if (hit) return (await hit.json()) as T

  const data = await load()
  await cache
    ?.put(
      url,
      new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${ttlSeconds}`,
        },
      }),
    )
    .catch(() => {})
  return data
}
