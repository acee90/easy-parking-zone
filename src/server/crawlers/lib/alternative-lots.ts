/**
 * 후기 본문에서 "다른 주차장 이름" 뽑아내기
 *
 * 사람들이 주차장 후기를 읽는 진짜 이유는 대개 "여기 말고 어디에 대야 하나"다.
 * 차이나타운공영주차장 후기 14건을 읽어보면 인천내항 8부두(무료, 도보 10분),
 * 송월동 동화마을 공영주차장, 한중문화관 공영주차장이 반복해서 등장한다.
 * 그 정보가 지금은 비슷비슷한 블로그 덤프 안에 묻혀 있어서 여기서 끄집어낸다.
 *
 * 정밀도 우선. 오매칭 하나가 사람을 엉뚱한 주차장으로 보낸다.
 * 이름을 짧게 자르는 실수(→ 매칭 실패)는 감수하되, 엉뚱한 말을 이름으로
 * 만들어내는 실수는 하지 않는다.
 *
 * 순수 함수. DB·네트워크 접근 없음.
 */

export interface LotNameCandidate {
  /** 본문에서 뽑은 원형 이름 */
  name: string
  /** 매칭용 정규화 이름 */
  normalized: string
  /** 몇 건의 글에서 언급됐나 */
  count: number
  /** 그 언급 근처에 '무료' 가 있었나 */
  isFreeHint: boolean
}

/**
 * 이름 후보 덩어리.
 * 앞쪽 토큰을 최대 3개까지 붙이고(= 이름 전체 최대 4토큰) 끝이 주차장/주차타워인 것만 본다.
 * 공백은 스페이스·탭만 허용한다 — 줄바꿈을 넘어가면 남의 문장을 이름에 끌어들인다.
 */
const MENTION_PATTERN =
  '(?<![가-힣A-Za-z0-9])(?:[가-힣A-Za-z0-9]+[ \\t]+){0,3}[가-힣A-Za-z0-9]*주차(?:장|타워)(?![소치])'

/** 이름 최대 토큰 수 */
const MAX_TOKENS = 4

/** '무료' 를 찾아볼 언급 주변 글자 수 */
const FREE_HINT_WINDOW = 20

/**
 * 여기서 이름이 끊긴다. 지시어·거리 표현·서술어처럼 고유명이 될 수 없는 말.
 * 앞 토큰을 붙여 나가다 이 중 하나를 만나면 즉시 멈춘다.
 */
const STOPWORDS = new Set([
  // 지시어
  '이',
  '그',
  '저',
  '요',
  '해당',
  '여기',
  '저기',
  '거기',
  '이곳',
  '그곳',
  '저곳',
  '다른',
  '또다른',
  '각',
  '모든',
  '여러',
  '첫',
  '첫번째',
  '두번째',
  '세번째',
  // 위치·거리 표현
  '근처',
  '주변',
  '인근',
  '거리',
  '도보',
  '걸어서',
  '차로',
  '위',
  '아래',
  '앞',
  '뒤',
  '옆',
  '안',
  '밖',
  '쪽',
  '방향',
  '곳',
  '데',
  '바로',
  '건너편',
  '맞은편',
  // 접속·부사
  '그리고',
  '하지만',
  '그래서',
  '대신',
  '또',
  '및',
  '등',
  '약',
  '총',
  '좀',
  '조금',
  '많이',
  '가장',
  '제일',
  '진짜',
  '정말',
  '완전',
  '역시',
  '참고로',
  '결국',
  '그냥',
  '일단',
  '우선',
  '먼저',
  '나중',
  '마침',
  '다시',
  '이제',
  '아직',
  '벌써',
  '항상',
  '늘',
  '자주',
  '가끔',
  '매우',
  '아주',
  '너무',
  '잠깐',
  '잠시',
  '함께',
  '같이',
  '미리',
  '특히',
  '물론',
  '실제로',
  '대략',
  '대충',
  '무조건',
  '확실히',
  '당연히',
  '굳이',
  '괜히',
  '어쨌든',
  '아무튼',
  '그런데',
  '근데',
  '그럼',
  '그러면',
  '따라서',
  '그래도',
  '오히려',
  '심지어',
  '게다가',
  '이번',
  '저번',
  '다음',
  '지난',
  // 화자·시점
  '저희',
  '우리',
  '제가',
  '저는',
  '오늘',
  '어제',
  '내일',
  '최근',
  '요즘',
  '평일',
  '주말',
  '오전',
  '오후',
  '아침',
  '점심',
  '저녁',
  '새벽',
  '대부분',
  '대체로',
  '보통',
  '입구',
  '출구',
  '건너',
  '반대편',
  // 행위
  '이용',
  '주차',
  '방문',
  '추천',
  '소개',
  '검색',
  '이동',
])

/**
 * 이름에 붙여도 되지만 이것만으로는 고유명이 아니다.
 * "부평역 공영 주차장" 처럼 사이에 끼면 살리고, "공영 주차장" 처럼 홀로 남으면 버린다.
 */
const GENERIC_MODIFIERS = new Set([
  '공영',
  '민영',
  '사설',
  '공공',
  '무료',
  '유료',
  '노상',
  '노외',
  '부설',
  '전용',
  '임시',
  '지하',
  '지상',
  '옥상',
  '실내',
  '실외',
  '기계식',
  '자주식',
  '무인',
  '자전거',
  '이륜차',
  '오토바이',
  // 이용 대상으로 나눈 구획. 주차장 이름이 아니라 자리 종류다
  '장애인',
  '경차',
  '전기차',
  '임산부',
  '여성',
  '교직원',
  '직원',
  '고객',
  '손님',
  '방문객',
  '방문자',
  '관람객',
  '거주자우선',
  '거주자',
  '입주민',
  '입주자',
  '대형차',
  '화물차',
  '관광버스',
  '버스',
])

/** 긴 것부터 지워야 '거주자우선' 이 '거주자' + 살아남은 '우선' 로 쪼개지지 않는다 */
const GENERIC_BY_LENGTH_DESC = [...GENERIC_MODIFIERS].sort((a, b) => b.length - a.length)

/** "5분", "10m" 같은 수량 표현. 이름의 일부일 수 없다 ("8부두" 는 단위가 아니라 통과한다) */
const MEASURE_RE =
  /^\d+(?:분|초|시간|시|일|년|월|원|개|대|번|층|미터|퍼센트|m|km|%)(?:쯤|경|께|간|여)?$/i

/**
 * 서술어·연결어미·방위 표현으로 끝나는 토큰. "없는 인천내항 8부두 주차장" 의 '없는' 을 잘라낸다.
 *
 * '고'(넓고·유료고)는 잘라내는 쪽이 이득이 크다고 보고 넣었다 — '인일고' 같은 학교 줄임말이
 * 같이 잘리지만, 연결어미 '고' 를 살려두면 "대부분 유료고 무료주차장" 같은 쓰레기가 이름이 된다.
 * 반대로 '서'(경찰서·소방서), '면'(OO면), '가'(종로1가), '리'(OO리) 는 실제 지명·기관명의 끝이라
 * 일부러 넣지 않았다. 이름을 잘라먹는 실수는 매칭 실패로 끝나지만,
 * 엉뚱한 말을 이름으로 만들면 사람을 다른 주차장으로 보낸다.
 */
const TOKEN_STOP_ENDING_RE =
  /(?:는|은|던|니|며|데|고|쪽|었다|았다|해서|어서|아서|워서|와서|져서|라서|라고|지만|면서|니까|다가|도록|습니다|입니다)$/

/**
 * 토큰 끝에 붙은 조사. '근처에', '주변의' 처럼 조사가 붙으면 사전에서 못 찾는다.
 * 조사를 떼고 한 번 더 대조하려고 쓴다 — 토큰 자체를 바꾸지는 않는다.
 * ('동화마을' 에서 '을' 을 떼도 '동화마' 는 사전에 없으니 그대로 이름으로 남는다)
 */
const JOSA_RE =
  /(?:에서|에게|으로|에는|에도|까지|부터|보다|라도|처럼|만큼|이나|에|의|은|는|이|가|을|를|로|와|과|도|만)$/

/** 끝의 '주차장' / '주차타워' */
const SUFFIX_RE = /(?:주차장|주차타워)$/

/** 괄호와 그 안 내용 */
const BRACKET_RE = /[([{（【][^)\]}）】]*[)\]}）】]/g

type TokenKind = 'proper' | 'generic' | 'stop'

function classifyToken(token: string): TokenKind {
  if (!token) return 'stop'
  if (STOPWORDS.has(token) || STOPWORDS.has(token.replace(JOSA_RE, ''))) return 'stop'
  if (MEASURE_RE.test(token)) return 'stop'
  // 한 글자 토큰까지 서술어 규칙을 적용하면 '동', '은' 같은 지명 조각이 날아간다
  if (token.length >= 2 && TOKEN_STOP_ENDING_RE.test(token)) return 'stop'
  if (GENERIC_MODIFIERS.has(token)) return 'generic'
  return 'proper'
}

/**
 * 고유명이 남아 있는지 본다.
 * 접미('주차장')와 일반 수식어('공영', '무료' …)를 다 걷어내고도
 * 두 글자 이상 남아야 실제 주차장 이름으로 인정한다.
 */
function hasProperNoun(name: string): boolean {
  let core = name.replace(BRACKET_RE, '').replace(/\s+/g, '').replace(SUFFIX_RE, '')
  for (const modifier of GENERIC_BY_LENGTH_DESC) {
    core = core.split(modifier).join('')
  }
  return core.length >= 2
}

/** 매칭 덩어리에서 앞쪽 군더더기를 잘라내 이름을 만든다. 고유명이 없으면 null */
function buildName(matched: string): string | null {
  const tokens = matched.trim().split(/\s+/)
  const kept = [tokens[tokens.length - 1]]
  for (let i = tokens.length - 2; i >= 0 && kept.length < MAX_TOKENS; i--) {
    if (classifyToken(tokens[i]) === 'stop') break
    kept.unshift(tokens[i])
  }
  const name = kept.join(' ')
  return hasProperNoun(name) ? name : null
}

interface Mention {
  name: string
  normalized: string
  isFreeHint: boolean
}

/** 글 1건에서 언급을 모두 훑는다 (같은 이름이 여러 번이면 여러 번 나온다) */
function scanMentions(text: string): Mention[] {
  if (!text) return []
  const out: Mention[] = []
  for (const match of text.matchAll(new RegExp(MENTION_PATTERN, 'g'))) {
    const name = buildName(match[0])
    if (!name) continue
    const start = match.index ?? 0
    const end = start + match[0].length
    // 창이 줄을 넘어가면 옆 문단의 '무료' 를 이 주차장 것으로 착각한다
    const lineStart = text.lastIndexOf('\n', start) + 1
    const lineEndRaw = text.indexOf('\n', end)
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw
    const around = text.slice(
      Math.max(start - FREE_HINT_WINDOW, lineStart),
      Math.min(end + FREE_HINT_WINDOW, lineEnd),
    )
    out.push({
      name,
      normalized: normalizeLotName(name),
      isFreeHint: around.includes('무료'),
    })
  }
  return out
}

/** 이 길이 이하의 군더더기가 앞에 붙은 것으로 본다 ('결국', '이번' 같은 부사 한 토막) */
const MAX_STRAY_PREFIX = 3

/** 이보다 짧은 이름으로는 흡수하지 않는다 — 너무 짧으면 남의 이름을 삼킨다 */
const MIN_ABSORB_LENGTH = 3

/**
 * 같은 이름이 짧은 형태로도 관측됐다면 짧은 쪽으로 모은다.
 *
 * 부사 사전은 아무리 채워도 샌다. "결국 송월동 동화마을 공영주차장" 처럼
 * 앞에 한 토막이 더 붙은 형태는, 같은 글·같은 묶음 안에 깨끗한 형태가
 * 이미 있으면 그쪽이 맞다고 본다. 다만 '인천내항 8부두' 를 '8부두' 로
 * 깎아버리면 곤란하므로, 덧붙은 길이가 짧을 때만 흡수한다.
 */
function buildCanonicalMap(mentions: Mention[]): {
  target: Map<string, string>
  surface: Map<string, string>
} {
  const surface = new Map<string, string>()
  for (const mention of mentions) {
    if (mention.normalized && !surface.has(mention.normalized)) {
      surface.set(mention.normalized, mention.name)
    }
  }
  const keys = [...surface.keys()].sort((a, b) => a.length - b.length)
  const target = new Map<string, string>()
  for (const key of keys) {
    let resolved = key
    for (const shorter of keys) {
      if (shorter.length >= key.length) break
      if (
        shorter.length < MIN_ABSORB_LENGTH ||
        key.length - shorter.length > MAX_STRAY_PREFIX ||
        !key.endsWith(shorter)
      ) {
        continue
      }
      // 덧붙은 부분이 앞 토큰 하나와 정확히 같을 때만 군더더기로 본다.
      // '동인천역' 은 '동' + '인천역' 로 쪼개지지 않으므로 별개 주차장으로 남는다
      const extra = key.slice(0, key.length - shorter.length)
      const firstToken = (surface.get(key) ?? '')
        .split(/\s+/)[0]
        .replace(BRACKET_RE, '')
        .toLowerCase()
      if (firstToken !== extra) continue
      resolved = target.get(shorter) ?? shorter
      break
    }
    target.set(key, resolved)
  }
  return { target, surface }
}

function canonicalize(mentions: Mention[], groups: Mention[][]): Mention[][] {
  const { target, surface } = buildCanonicalMap(mentions)
  return groups.map((group) =>
    group.map((mention) => {
      const resolved = target.get(mention.normalized) ?? mention.normalized
      if (resolved === mention.normalized) return mention
      return { ...mention, normalized: resolved, name: surface.get(resolved) ?? mention.name }
    }),
  )
}

/** 글 1건의 본문에서 주차장 이름 후보를 뽑는다 (같은 이름은 1회만) */
export function extractLotNames(text: string): string[] {
  const raw = scanMentions(text)
  const [mentions] = canonicalize(raw, [raw])
  const seen = new Set<string>()
  const out: string[] = []
  for (const mention of mentions) {
    if (!mention.normalized || seen.has(mention.normalized)) continue
    seen.add(mention.normalized)
    out.push(mention.name)
  }
  return out
}

/** 여러 글의 후보를 모아 언급 건수로 집계한다 */
export function aggregateLotNames(texts: string[]): LotNameCandidate[] {
  const scanned = texts.map(scanMentions)
  const groups = canonicalize(scanned.flat(), scanned)

  const acc = new Map<
    string,
    { surfaces: Map<string, number>; count: number; isFreeHint: boolean }
  >()

  for (const group of groups) {
    const seenInThisText = new Set<string>()
    for (const mention of group) {
      if (!mention.normalized) continue
      let entry = acc.get(mention.normalized)
      if (!entry) {
        entry = { surfaces: new Map(), count: 0, isFreeHint: false }
        acc.set(mention.normalized, entry)
      }
      entry.surfaces.set(mention.name, (entry.surfaces.get(mention.name) ?? 0) + 1)
      if (mention.isFreeHint) entry.isFreeHint = true
      // 한 글에서 몇 번 나오든 1건 — 같은 글쓴이가 반복한 것뿐이다
      if (!seenInThisText.has(mention.normalized)) {
        seenInThisText.add(mention.normalized)
        entry.count += 1
      }
    }
  }

  const candidates: LotNameCandidate[] = []
  for (const [normalized, entry] of acc) {
    candidates.push({
      name: pickSurface(entry.surfaces),
      normalized,
      count: entry.count,
      isFreeHint: entry.isFreeHint,
    })
  }

  // 많이 언급된 순. 같으면 이름순으로 고정해 매번 같은 결과가 나오게 한다
  candidates.sort((a, b) => b.count - a.count || a.normalized.localeCompare(b.normalized))
  return candidates
}

/** 표기가 갈리면 가장 자주 쓰인 표기를, 그것도 같으면 더 자세한(긴) 표기를 쓴다 */
function pickSurface(surfaces: Map<string, number>): string {
  let best = ''
  let bestCount = -1
  for (const [surface, count] of surfaces) {
    if (count > bestCount || (count === bestCount && surface.length > best.length)) {
      best = surface
      bestCount = count
    }
  }
  return best
}

/**
 * 우리 DB 이름과 대조할 때 쓰는 정규화.
 * '제1' 과 '1' 은 통일하지 않는다 — 서로 다른 주차장일 수 있다.
 */
export function normalizeLotName(name: string): string {
  if (!name) return ''
  return (
    name
      .replace(BRACKET_RE, '')
      .replace(/\s+/g, '')
      // 숫자 앞의 서수 '제'만 떼어낸다. 숫자 자체는 그대로 둔다 —
      // '제1'과 '1'은 같은 곳이지만 '제1'과 '제2'는 다른 곳이다.
      //
      // 이게 없으면 후기의 "인천 내항 8부두 주차장"이 DB 의 "인천내항제8부두 주차장"
      // (KA-885092762, 무료)과 매칭되지 않는다. 차이나타운 표본에서 가장 많이 언급된
      // 대안이 바로 그곳이라 그냥 두면 기능의 핵심 사례가 링크되지 않는다.
      //
      // 안전성 실측(2026-09-02, 전체 31,994곳): 이 규칙으로 새로 겹치는 이름은 25건뿐이고
      // 그마저 대부분 같은 주차장의 다른 표기다('안동터미널제2주차장' / '안동터미널 2 공영 주차장').
      // 겹치는 이름은 호출부에서 매칭 대상에서 제외하므로 잘못된 링크로 이어지지 않는다.
      .replace(/제(?=\d)/g, '')
      .replace(/(?:공영주차장|주차장)$/, '')
      .toLowerCase()
  )
}
