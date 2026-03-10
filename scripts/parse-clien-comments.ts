/**
 * clien_comments.html 파싱 → JSON 변환
 *
 * 사용법: bun run scripts/parse-clien-comments.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const HTML_PATH = resolve(import.meta.dir, "../clien_comments.html");
const OUT_PATH = resolve(import.meta.dir, "clien-comments-raw.json");

const html = readFileSync(HTML_PATH, "utf-8");

interface Comment {
  id: string;
  authorId: string;
  nickname: string;
  content: string;
  date: string;
  likes: number;
  isReply: boolean;
  isByAuthor: boolean;
}

const comments: Comment[] = [];

// Split by comment_row boundaries
const rowRegex = /<div\s[^>]*class="comment_row([^"]*)"[^>]*data-author-id="([^"]*)"[^>]*data-comment-sn="(\d+)"[^>]*>/g;
let match: RegExpExecArray | null;
const positions: { index: number; classes: string; authorId: string; commentSn: string }[] = [];

while ((match = rowRegex.exec(html)) !== null) {
  positions.push({
    index: match.index,
    classes: match[1],
    authorId: match[2],
    commentSn: match[3],
  });
}

for (let i = 0; i < positions.length; i++) {
  const pos = positions[i];
  const start = pos.index;
  const end = i + 1 < positions.length ? positions[i + 1].index : html.length;
  const block = html.slice(start, end);

  // Nickname: <span title="닉네임">닉네임</span> inside contact_name
  const nickMatch = block.match(/<a[^>]*class="nickname"[^>]*>\s*<span\s+title="([^"]*)">/);
  const nickname = nickMatch ? nickMatch[1] : pos.authorId;

  // Content: extract from comment_content section only
  let content = "";
  const contentSection = block.match(/class="comment_content"[^>]*>([\s\S]*?)(?:<\/div>\s*<\/div>\s*$)/);
  if (contentSection) {
    const section = contentSection[1];
    // Primary: hidden input value with data-comment-modify
    const hiddenMatch = section.match(/value="([\s\S]*?)"\s*data-comment-modify/);
    if (hiddenMatch) {
      content = hiddenMatch[1].trim();
    } else {
      // Fallback: text from comment_view div (strip HTML tags)
      const viewMatch = section.match(/class="comment_view"[^>]*>([\s\S]*?)(?:<input|$)/);
      if (viewMatch) {
        content = viewMatch[1].replace(/<br\s*\/?>/g, "\n").replace(/<[^>]*>/g, "").trim();
      }
    }
  }

  // Date
  const dateMatch = block.match(/<span class="timestamp">([\d-]+\s[\d:]+)\s*<\/span>/);
  const date = dateMatch ? dateMatch[1].trim() : "";

  // Likes
  const likesMatch = block.match(/id="setLikeCount_\d+">(\d+)<\/strong>/);
  const likes = likesMatch ? parseInt(likesMatch[1], 10) : 0;

  const isReply = pos.classes.includes(" re");
  const isByAuthor = pos.classes.includes("by-author");

  // Decode HTML entities in content
  content = content
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  comments.push({
    id: pos.commentSn,
    authorId: pos.authorId,
    nickname,
    content,
    date,
    likes,
    isReply,
    isByAuthor,
  });
}

writeFileSync(OUT_PATH, JSON.stringify(comments, null, 2));
console.log(`✅ ${comments.length}개 댓글 파싱 완료 → ${OUT_PATH}`);

// Stats
const replies = comments.filter((c) => c.isReply).length;
const topLevel = comments.length - replies;
const byAuthor = comments.filter((c) => c.isByAuthor).length;
const withContent = comments.filter((c) => c.content.length > 0).length;
console.log(`  최상위 댓글: ${topLevel}개, 대댓글: ${replies}개`);
console.log(`  글쓴이 댓글: ${byAuthor}개`);
console.log(`  내용 있는 댓글: ${withContent}개`);
