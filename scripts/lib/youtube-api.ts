/**
 * YouTube Data API v3 래퍼
 *
 * 환경변수: YOUTUBE_API_KEY
 * https://developers.google.com/youtube/v3/docs
 *
 * 무료 할당: 10,000 units/일
 * - search.list: 100 units
 * - channels.list: 1 unit
 * - playlistItems.list: 1 unit
 * - commentThreads.list: 1 unit
 */

const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const PLAYLIST_ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems";
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
 * 채널 핸들(@xxx)로 uploads playlist ID 조회 (1 unit)
 */
export async function getUploadsPlaylistId(handle: string): Promise<string> {
  const params = new URLSearchParams({
    part: "contentDetails",
    forHandle: handle.replace(/^@/, ""),
    key: getApiKey(),
  });

  const res = await fetch(`${CHANNELS_URL}?${params}`);
  if (!res.ok) {
    throw new Error(`YouTube Channels API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as any;
  const playlistId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) {
    throw new Error(`채널 "${handle}"의 uploads playlist를 찾을 수 없습니다.`);
  }
  return playlistId;
}

/**
 * 채널 전체 영상 목록 수집 (1 unit/call, 50개씩 페이지네이션)
 */
export async function getChannelVideos(
  playlistId: string,
  maxTotal = 500
): Promise<YouTubeVideo[]> {
  const videos: YouTubeVideo[] = [];
  let pageToken: string | undefined;

  while (videos.length < maxTotal) {
    const params = new URLSearchParams({
      part: "snippet",
      playlistId,
      maxResults: "50",
      key: getApiKey(),
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`${PLAYLIST_ITEMS_URL}?${params}`);
    if (!res.ok) {
      throw new Error(`YouTube PlaylistItems API ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    for (const item of data.items ?? []) {
      const s = item.snippet;
      videos.push({
        videoId: s.resourceId.videoId,
        title: s.title,
        description: s.description,
        thumbnailUrl:
          s.thumbnails?.high?.url ??
          s.thumbnails?.medium?.url ??
          s.thumbnails?.default?.url ??
          "",
        channelTitle: s.channelTitle,
        publishedAt: s.publishedAt,
      });
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return videos;
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
