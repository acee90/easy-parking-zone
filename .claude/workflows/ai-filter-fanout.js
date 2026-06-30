export const meta = {
  name: 'ai-filter-fanout',
  description:
    'Stage 3 ai-filter fan-out with a HARD concurrency cap (deterministic queue, not single-message spawn). Runs each medium-candidates chunk through the pipeline-ai-filter subagent, verifies output integrity, and retries only the failed chunk.',
  whenToUse:
    'run-pipeline Stage 3 — replaces the fragile "spawn all chunks in one message" sliding-window approach with a real queued concurrency cap.',
  phases: [
    { title: 'AI Filter', detail: 'pipeline-ai-filter subagent per chunk (capped concurrency)' },
    {
      title: 'Verify',
      detail: 'integrity check: raw_id set match, valid JSON, no prefix pollution',
    },
  ],
}

// Chunk list: [ { in: "<abs medium-candidates-NN.json>", out: "<abs ai-results-NN.json>" }, ... ]
//
// The script has no filesystem access, so it cannot discover chunk files itself. In THIS harness
// the `args` global is NOT plumbed through to workflow scripts, so we cannot rely on args.chunks
// either. The canonical driver `scripts/gen-aifilter-workflow.ts <DIR>` reads this file, inlines
// the chunk array at the marker below, and writes a runnable copy that you invoke via scriptPath.
// The args path is kept as a best-effort fallback in case a future harness plumbs args through.
const INLINE_CHUNKS = [] /* __CHUNKS__ */

let parsedArgs = args
if (typeof parsedArgs === 'string') {
  try {
    parsedArgs = JSON.parse(parsedArgs)
  } catch (e) {
    parsedArgs = {}
  }
}

const chunks = INLINE_CHUNKS.length ? INLINE_CHUNKS : (parsedArgs && parsedArgs.chunks) || []
if (!chunks.length) {
  log('ai-filter-fanout: no chunks (neither inlined nor args.chunks) — nothing to do')
  return { total: 0, ok: 0, failed: 0, okFiles: [], failedChunks: [] }
}

const MAX_ATTEMPTS = 3
const base = (p) => String(p).split('/').pop()

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['valid', 'inputCount', 'outputCount', 'missingRawIds', 'extraRawIds', 'note'],
  properties: {
    valid: {
      type: 'boolean',
      description:
        'true only if output is parseable JSON with no non-JSON prefix AND its raw_id set exactly equals the input raw_id set',
    },
    inputCount: { type: 'integer' },
    outputCount: { type: 'integer' },
    missingRawIds: {
      type: 'array',
      items: { type: 'integer' },
      description: 'raw_ids present in input but absent from output',
    },
    extraRawIds: {
      type: 'array',
      items: { type: 'integer' },
      description: 'raw_ids in output not present in input',
    },
    note: {
      type: 'string',
      description:
        'short reason when invalid (truncation, wrong filename, stderr prefix, malformed json), else empty',
    },
  },
}

const filterPrompt = (c) =>
  [
    `${c.in} 파일을 읽고 pipeline-ai-filter 사양(AI_SUMMARY_SYSTEM_PROMPT)으로 filter 판정 + 통과 시 lot-agnostic 200~600자 summary를 생성한다.`,
    `결과는 정확히 이 경로에 Write: ${c.out}`,
    `엄수: (1) 입력 candidates 전건 처리 — 생략·truncate 금지. (2) 출력 results의 raw_id 집합은 입력 candidates의 raw_id 집합과 정확히 일치. (3) 파일 맨 앞에 stderr/로그 등 비-JSON 텍스트를 prepend 금지 — 순수 JSON만.`,
    `출력 파일명은 반드시 ${base(c.out)} 그대로 (chunk 단어 누락/접미사 변형 금지).`,
  ].join('\n')

const verifyPrompt = (c) =>
  [
    `두 파일을 Read로 읽어라: 입력=${c.in}, 출력=${c.out}.`,
    `출력 파일이 (a) 유효한 JSON이고 맨 앞에 비-JSON prefix가 없는지, (b) results[].raw_id 집합이 입력 candidates의 raw_id 집합과 정확히 일치하는지(누락/추가 없음) 검사한다.`,
    `파일이 없거나 파싱 실패하면 valid=false, outputCount=0 으로 보고.`,
    `StructuredOutput으로만 반환. 파일을 수정하지 마라.`,
  ].join('\n')

async function processChunk(c) {
  let last = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await agent(filterPrompt(c), {
      agentType: 'pipeline-ai-filter',
      phase: 'AI Filter',
      label: `filter:${base(c.out)}#${attempt}`,
    })
    const v = await agent(verifyPrompt(c), {
      schema: VERDICT_SCHEMA,
      phase: 'Verify',
      label: `verify:${base(c.out)}#${attempt}`,
    })
    last = v
    if (v && v.valid) {
      return { out: c.out, valid: true, attempts: attempt, count: v.outputCount }
    }
    log(
      `retry ${base(c.out)} (attempt ${attempt}/${MAX_ATTEMPTS}): ${v ? v.note : 'verify agent died'}`,
    )
  }
  return { out: c.out, valid: false, attempts: MAX_ATTEMPTS, verdict: last }
}

// parallel() = the hard cap. With N chunks, only min(16, cpu-2) agent() calls run at once;
// the rest queue. A thrown thunk resolves to null instead of stalling the batch.
const settled = await parallel(chunks.map((c) => () => processChunk(c)))
const results = settled.filter(Boolean)

const ok = results.filter((r) => r.valid)
const failed = results.filter((r) => !r.valid)
log(`ai-filter-fanout done: ${ok.length} ok, ${failed.length} failed (of ${chunks.length} chunks)`)

return {
  total: chunks.length,
  ok: ok.length,
  failed: failed.length,
  okFiles: ok.map((r) => r.out),
  failedChunks: failed.map((r) => ({ out: r.out, verdict: r.verdict || null })),
}
