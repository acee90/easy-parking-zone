interface WebSource {
  id: number;
  full_text_excerpt: string;
  title: string;
  lot_name?: string;
}

interface EvalResult {
  id: number;
  filterPassed: boolean;
  filterRemovedBy: string | null;
  sentimentScore: number;
}

async function evaluateSource(source: WebSource): Promise<EvalResult> {
  // 앞 2000자만 사용
  const text = (source.full_text_excerpt || "").substring(0, 2000);
  const title = source.title || "";

  // 기본 조건 체크: 주차 키워드 거의 없음
  const parkingKeywordCount = (
    (text.match(
      /주차|주차장|입차|출차|파킹|주차비|주차료|주차 가능|주차하기/g
    ) || []).length +
    (title.match(
      /주차|주차장|입차|출차|파킹|주차비|주차료|주차 가능|주차하기/g
    ) || []).length
  );

  if (parkingKeywordCount < 2) {
    return {
      id: source.id,
      filterPassed: false,
      filterRemovedBy: "irrelevant",
      sentimentScore: 3,
    };
  }

  // A. 실이용자 직접 경험형 체크
  const personalExperienceMarkers = [
    /주차했|주차했어요|주차해봤|다녀왔|다녀왔어요|이용해봤|이용해봤는데|주차하러|주차하면서|주차하다가|주차했더니|주차했는데|주차해서|주차한 후|주차한다면|주차해야|입차했|출차했|나는|저는|우리|내가|제가|뭔가 어려웠|어려웠어요|괜찮았|좋았어|이용하면|방문했|갔었|탔는데|탔어요|차를 세웠|차를 세워|차를 댔|차를 대고/i,
  ];

  const hasPersonalExperience = personalExperienceMarkers.some((marker) =>
    marker.test(text)
  );

  if (hasPersonalExperience) {
    // 진입로/주차면/요금/혼잡도 중 1개 이상 구체 묘사
    const detailedDescriptors = [
      /진입로|진입|회전하|진입이 (좁|어렵|쉬)|진입이 복잡|좁|넓|넓은|좁은|오르막|내리막|가파른|지하|계단|엘리베이터|턴테이블|진입로가|진입이|진입할 때/i, // 진입로
      /주차면|주차 칸|주차 공간|주차칸|주차 자리|주차공간|아주 좁|정말 좁|매우 좁|불편했|넓었|여유|공간|좌우|길이|깊이|차폭|공간이 넓|공간이 좁/i, // 주차면
      /요금|가격|비용|비싼|싸|원|시간당|30분|1시간|2시간|3시간|4시간|5시간|월정액|정기권|할인|카드|현금|결제|시간 초과|무료|요금이|가격이/i, // 요금
      /혼잡|차량이 많|찬 상태|비는|만차|만석|우회|기다|대기|예약|선예약|선점|밤시간|낮시간|피크|타임|이른|저녁|점심|아침|혼잡도|차 많|차 적/i, // 혼잡도
    ];

    const hasDetailedDescription = detailedDescriptors.some((desc) =>
      desc.test(text)
    );

    if (hasDetailedDescription) {
      const parkingScore = evaluateSentiment(text);
      return {
        id: source.id,
        filterPassed: true,
        filterRemovedBy: null,
        sentimentScore: parkingScore,
      };
    }
  }

  // B. 단일 주차장 공식 안내형 체크
  if (isOfficialGuidePage(text)) {
    const hasLocationAndPricingAndTime = checkLocationPricingTime(text);
    if (hasLocationAndPricingAndTime) {
      return {
        id: source.id,
        filterPassed: true,
        filterRemovedBy: null,
        sentimentScore: 3, // 정보 중립
      };
    }
  }

  // 판정: thin, boilerplate, ad, realestate, news, irrelevant
  const removal = classifyRemovalReason(text, title);

  return {
    id: source.id,
    filterPassed: false,
    filterRemovedBy: removal,
    sentimentScore: 3,
  };
}

function isOfficialGuidePage(text: string): boolean {
  const firstKChars = text.substring(0, 1000);

  const officialMarkers = [
    /주차장 안내|공영주차장|주차 정보|주차 요금|주차 시간|운영 시간|운영시간|주차 시설|주차장 정보|주차장 위치|위치 요금|위치정보/i,
  ];
  const boilerplateMarkers = [
    /사용자 리뷰|방문자의 의견|체험단|협찬|광고|광고성|원고료|쿠팡파트너|아마존|이 글은|제휴|제공받았|지원받았/i,
  ];

  const isOfficial = officialMarkers.some((marker) =>
    marker.test(firstKChars)
  );
  const isNotBoilerplate = !boilerplateMarkers.some((marker) =>
    marker.test(text)
  );

  return isOfficial && isNotBoilerplate;
}

function checkLocationPricingTime(text: string): boolean {
  const hasLocation =
    /위치|주소|지점|호선|역|근처|도로|번지|번길|지역|곳|곳곳/.test(text);
  const hasPricing = /요금|가격|비용|시간당|시간|원|₩|￥/.test(text);
  const hasTime = /운영|시간|개시|폐장|오픈|오후|오전|월|화|수|목|금|토|일|시간대/.test(
    text
  );

  return hasLocation && hasPricing && hasTime;
}

function classifyRemovalReason(text: string, title: string): string {
  const combined = text + " " + title;
  const firstKChars = combined.substring(0, 1000);

  // ad
  if (/체험단|협찬|광고|쿠팡|아마존|제휴|원고료|지원받았|제공받았|광고료|광고 콘텐츠/.test(combined)) {
    return "ad";
  }

  // realestate
  if (/분양|택지|아파트|주택|부동산|매매|임대|계약금|평수|건평|전용면적/.test(firstKChars)) {
    return "realestate";
  }

  // news
  if (/기자|보도자료|발표|뉴스|뉴스레터|보도|시청|공식 발표|시장|지자체|뉴스통신|보도/.test(
    firstKChars
  )) {
    return "news";
  }

  // thin: 주차 관련 내용이 3문장 미만 또는 문장이 적음
  const sentenceCount = (combined.match(/[\.\!\?]/g) || []).length;
  const parkingLineCount = (
    (text.match(/주차|주차장|입차|출차|파킹|주차비|주차료/g) || []).length
  );

  if (sentenceCount < 3) {
    return "thin";
  }

  if (parkingLineCount < 2) {
    return "thin";
  }

  // boilerplate: 여러 주차장 나열, DB 필드만 나열 등 개인 경험 전무
  if (
    /주차장 목록|주차장 모음|주소 조회|전화번호|관리기관|구획수|주차료|운영시간|주차시설 유형|시설별|차이가 있습니다/.test(
      combined
    ) &&
    !/주차했|이용해봤|다녀왔|좋았|어려웠|힘들었|방문|갔었|탔는데|차를 세웠/.test(combined)
  ) {
    return "boilerplate";
  }

  // 분류 불가: thin 기본값
  return "thin";
}

function evaluateSentiment(text: string): number {
  const positive = /쉬운|넓은|깨끗|좋았|편했|만족|괜찮|좋아|추천|최고|훌륭|완벽|쉬워|편해|좋은|편리|우수|효율|만족스럽|괜찮습니다|좋습니다|추천합니다/.test(
    text
  );
  const negative = /좁은|어려운|불편|힘들었|어려웠|주차하기 힘|주차 어려|혼잡|복잡|막힘|나쁜|최악|끔찍|좁아|힘들어|불편합니다|최악입니다|어렵습니다|어려워요/.test(
    text
  );

  if (positive && !negative) return 5;
  if (negative && !positive) return 1;
  return 3;
}

async function processChunks(
  chunkNumbers: number[]
): Promise<Record<number, EvalResult[]>> {
  const results: Record<number, EvalResult[]> = {};

  for (const chunkNum of chunkNumbers) {
    console.log(`Processing chunk ${chunkNum}...`);

    const chunkPath = `/Users/junhee/Documents/projects/parking-map/main/data/filter-v2-recheck/subagent-input/chunk-${String(chunkNum).padStart(2, "0")}.json`;
    const chunkData = await Bun.file(chunkPath).json() as WebSource[];

    results[chunkNum] = [];

    for (const source of chunkData) {
      const result = await evaluateSource(source);
      results[chunkNum].push(result);
    }

    const passed = results[chunkNum].filter((r) => r.filterPassed).length;
    console.log(
      `  Chunk ${chunkNum}: ${passed}/${chunkData.length} passed`
    );
  }

  return results;
}

async function main() {
  const chunkNumbers = [4, 5, 6, 7];
  const allResults = await processChunks(chunkNumbers);

  // 결과 저장
  for (const [chunk, results] of Object.entries(allResults)) {
    const outputPath = `/tmp/eval-v4-partial-${chunk}.json`;
    await Bun.write(outputPath, JSON.stringify({ results }, null, 2));
    console.log(`Saved ${outputPath}`);
  }

  // 전체 통계
  const allFlat = Object.values(allResults).flat();
  const passed = allFlat.filter((r) => r.filterPassed).length;
  const breakdown: Record<string, number> = {};

  for (const result of allFlat) {
    if (!result.filterPassed && result.filterRemovedBy) {
      breakdown[result.filterRemovedBy] = (breakdown[result.filterRemovedBy] || 0) + 1;
    }
  }

  console.log(`\nTotal: ${passed}/${allFlat.length} passed (${((passed / allFlat.length) * 100).toFixed(1)}%)`);
  console.log("Breakdown:", breakdown);
}

main().catch(console.error);
