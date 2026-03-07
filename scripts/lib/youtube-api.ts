/**
 * YouTube Data API v3 래퍼
 *
 * 환경변수: YOUTUBE_API_KEY
 * https://developers.google.com/youtube/v3/docs
 *
 * 무료 할당: 10,000 units/일
 * - search.list: 100 units
 * - commentThreads.list: 1 unit
 */

const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const COMMENTS_URL = "https://www.googleapis.com/youtube/v3/commentThreads";

export interface YouTubeVideo {
  videoId: string;
  title: string;
  description: string;
  thumbnailUrl: string;
  channelTitle: string;
  publishedAt: string;
}

export interface YouTubeComment {
  commentId: string;
  text: string;
  author: string;
  likeCount: number;
  publishedAt: string;
}

function getApiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    throw new Error("YOUTUBE_API_KEY가 .env에 설정되지 않았습니다.");
  }
  return key;
}

/**
 * YouTube 영상 검색 (100 units/call)
 */
export async function searchVideos(
  query: string,
  maxResults = 5
): Promise<YouTubeVideo[]> {
  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(maxResults),
    order: "relevance",
    relevanceLanguage: "ko",
    key: getApiKey(),
  });

  const res = await fetch(`${SEARCH_URL}?${params}`);
  if (!res.ok) {
    throw new Error(`YouTube Search API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as any;
  return (data.items ?? []).map((item: any) => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    description: item.snippet.description,
    thumbnailUrl:
      item.snippet.thumbnails?.high?.url ??
      item.snippet.thumbnails?.medium?.url ??
      item.snippet.thumbnails?.default?.url ??
      "",
    channelTitle: item.snippet.channelTitle,
    publishedAt: item.snippet.publishedAt,
  }));
}

/**
 * 영상 댓글 수집 (1 unit/call)
 */
export async function getComments(
  videoId: string,
  maxResults = 20
): Promise<YouTubeComment[]> {
  const params = new URLSearchParams({
    part: "snippet",
    videoId,
    maxResults: String(maxResults),
    order: "relevance",
    textFormat: "plainText",
    key: getApiKey(),
  });

  const res = await fetch(`${COMMENTS_URL}?${params}`);
  if (!res.ok) {
    // 댓글 비활성화된 영상 등
    if (res.status === 403) return [];
    throw new Error(`YouTube Comments API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as any;
  return (data.items ?? []).map((item: any) => {
    const s = item.snippet.topLevelComment.snippet;
    return {
      commentId: item.id,
      text: s.textDisplay,
      author: s.authorDisplayName,
      likeCount: s.likeCount ?? 0,
      publishedAt: s.publishedAt,
    };
  });
}
