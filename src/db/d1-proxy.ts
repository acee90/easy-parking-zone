/**
 * D1 REST API를 D1Database 인터페이스로 래핑
 * drizzle-orm/d1 드라이버를 그대로 사용하므로 결과 매핑이 동일
 */
export function createD1Binding(
  apiToken: string,
  accountId: string,
  databaseId: string,
): D1Database {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`

  async function execute(sql: string, params: unknown[] = []) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`[D1 Proxy] API error: ${res.status} ${text}`)
    }

    const data = (await res.json()) as {
      result: {
        results: Record<string, unknown>[]
        success: boolean
        meta: Record<string, unknown>
      }[]
    }

    const result = data.result?.[0]
    return {
      results: result?.results ?? [],
      success: result?.success ?? true,
      meta: result?.meta ?? {},
    }
  }

  function createStatement(sql: string): D1PreparedStatement {
    let boundParams: unknown[] = []

    const stmt: D1PreparedStatement = {
      bind(...params: unknown[]) {
        boundParams = params
        return stmt
      },
      async first<T>(colName?: string): Promise<T | null> {
        const { results } = await execute(sql, boundParams)
        if (!results[0]) return null
        if (colName) return (results[0] as Record<string, unknown>)[colName] as T
        return results[0] as T
      },
      async all<T>(): Promise<D1Result<T>> {
        const { results, meta } = await execute(sql, boundParams)
        return {
          results: results as T[],
          success: true,
          meta: meta as D1Result<T>['meta'],
        }
      },
      async run(): Promise<D1Result<unknown>> {
        const { results, meta } = await execute(sql, boundParams)
        return {
          results,
          success: true,
          meta: meta as D1Result<unknown>['meta'],
        }
      },
      async raw<T>(): Promise<T[]> {
        const { results } = await execute(sql, boundParams)
        return results.map((row) => Object.values(row)) as T[]
      },
    }

    return stmt
  }

  return {
    prepare(sql: string) {
      return createStatement(sql)
    },
    async exec(sql: string) {
      await execute(sql)
      return { count: 1, duration: 0 }
    },
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = []
      for (const stmt of statements) {
        results.push(await stmt.all<T>())
      }
      return results
    },
    async dump(): Promise<ArrayBuffer> {
      throw new Error('dump() not supported via REST API proxy')
    },
  }
}
