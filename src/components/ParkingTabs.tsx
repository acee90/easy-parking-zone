import { useState, useEffect } from "react";
import type { BlogPost, UserReview, ParkingMedia } from "@/types/parking";
import { fetchBlogPosts, fetchParkingMedia } from "@/server/parking";
import { fetchUserReviews, createReview, deleteReview } from "@/server/reviews";
import { authClient } from "@/lib/auth-client";
import {
  MessageSquare,
  FileText,
  Star,
  User,
  Pen,
  Play,
} from "lucide-react";

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">",
    "&quot;": '"', "&#39;": "'", "&apos;": "'",
  };
  return text.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => entities[m] ?? m);
}

function BlogPostCard({ post }: { post: BlogPost }) {
  const sourceLabel = post.source === "naver_blog" ? "블로그" : "카페";
  return (
    <a
      href={post.sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-lg border px-3 py-2.5 hover:bg-gray-50 transition-colors"
    >
      <p className="text-xs font-medium text-gray-900 line-clamp-1 mb-1">
        {post.title}
      </p>
      <p className="text-xs text-gray-600 line-clamp-2 leading-relaxed mb-1.5">
        {post.snippet}
      </p>
      <p className="text-[11px] text-muted-foreground">
        {sourceLabel} · {post.author}
        {post.publishedAt && ` · ${post.publishedAt.slice(0, 10)}`}
      </p>
    </a>
  );
}

function StarRating({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className="cursor-pointer p-0.5"
        >
          <Star
            className={`size-4 ${n <= value ? "fill-yellow-400 text-yellow-400" : "text-gray-300"}`}
          />
        </button>
      ))}
    </div>
  );
}

function UserReviewCard({
  review,
  onDelete,
}: {
  review: UserReview;
  onDelete?: () => void;
}) {
  return (
    <div className="rounded-lg border px-3 py-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          {review.author.profileImage ? (
            <img
              src={review.author.profileImage}
              alt=""
              className="size-5 rounded-full"
            />
          ) : (
            <User className="size-4 text-muted-foreground" />
          )}
          <span className="text-xs font-medium">{review.author.nickname}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5">
            {[1, 2, 3, 4, 5].map((n) => (
              <Star
                key={n}
                className={`size-3 ${n <= review.scores.overall ? "fill-yellow-400 text-yellow-400" : "text-gray-200"}`}
              />
            ))}
          </div>
          <span className="text-[11px] text-muted-foreground">
            {review.createdAt.slice(0, 10)}
          </span>
        </div>
      </div>
      {review.comment && (
        <p className="text-xs text-gray-700 leading-relaxed">
          {review.comment}
        </p>
      )}
      {review.isMine && onDelete && (
        <div className="flex justify-end mt-1">
          <button
            onClick={onDelete}
            className="text-[11px] text-red-400 hover:text-red-600 cursor-pointer"
          >
            삭제
          </button>
        </div>
      )}
    </div>
  );
}

function ReviewForm({
  parkingLotId,
  onSubmitted,
}: {
  parkingLotId: string;
  onSubmitted: () => void;
}) {
  const { data: session } = authClient.useSession();
  const [overallScore, setOverallScore] = useState(0);
  const [comment, setComment] = useState("");
  const [guestNickname, setGuestNickname] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (overallScore < 1) return;
    setSubmitting(true);
    setError(null);
    try {
      await createReview({
        data: {
          parkingLotId,
          entryScore: overallScore,
          spaceScore: overallScore,
          passageScore: overallScore,
          exitScore: overallScore,
          overallScore,
          comment: comment || undefined,
          guestNickname: session ? undefined : guestNickname || undefined,
        },
      });
      onSubmitted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "오류가 발생했습니다");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border p-3 space-y-3">
      {!session && (
        <input
          type="text"
          value={guestNickname}
          onChange={(e) => setGuestNickname(e.target.value)}
          placeholder="닉네임 (선택)"
          maxLength={20}
          className="w-full rounded-md border px-2.5 py-1.5 text-xs"
        />
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">초보 추천도</span>
        <StarRating value={overallScore} onChange={setOverallScore} />
      </div>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={200}
        rows={2}
        placeholder="진입로, 주차면 크기, 통로 여유, 출차 난이도 등 경험을 적어주세요"
        className="w-full rounded-md border px-2.5 py-1.5 text-xs resize-none"
      />

      {error && <p className="text-xs text-red-500">{error}</p>}

      <button
        onClick={handleSubmit}
        disabled={overallScore < 1 || submitting}
        className="w-full rounded-md bg-blue-500 py-2 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
      >
        {submitting ? "등록 중..." : "등록하기"}
      </button>

      {!session && (
        <p className="text-[11px] text-muted-foreground text-center">
          로그인하면 리뷰를 수정/삭제할 수 있어요
        </p>
      )}
    </div>
  );
}

interface ParkingTabsProps {
  lotId: string;
}

export function ParkingTabs({ lotId }: ParkingTabsProps) {
  const [blogPosts, setBlogPosts] = useState<BlogPost[]>([]);
  const [userReviews, setUserReviews] = useState<UserReview[]>([]);
  const [media, setMedia] = useState<ParkingMedia[]>([]);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewKey, setReviewKey] = useState(0);
  const [activeTab, setActiveTab] = useState<"reviews" | "media" | "blog">("reviews");

  useEffect(() => {
    fetchBlogPosts({ data: { parkingLotId: lotId } })
      .then(setBlogPosts)
      .catch(() => setBlogPosts([]));
    fetchUserReviews({ data: { parkingLotId: lotId } })
      .then(setUserReviews)
      .catch(() => setUserReviews([]));
    fetchParkingMedia({ data: { parkingLotId: lotId } })
      .then(setMedia)
      .catch(() => setMedia([]));
    setShowReviewForm(false);
    setActiveTab("reviews");
  }, [lotId]);

  const refreshReviews = () => {
    fetchUserReviews({ data: { parkingLotId: lotId } })
      .then(setUserReviews)
      .catch(() => setUserReviews([]));
    setShowReviewForm(false);
    setReviewKey((k) => k + 1);
  };

  const tabs = [
    { key: "reviews" as const, icon: <MessageSquare className="size-3.5" />, label: "리뷰", count: userReviews.length },
    { key: "media" as const, icon: <Play className="size-3.5" />, label: "영상", count: media.length },
    { key: "blog" as const, icon: <FileText className="size-3.5" />, label: "블로그", count: blogPosts.length },
  ];

  return (
    <div className="border-t">
      <div className="flex">
        {tabs.map(({ key, icon, label, count }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === key
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {icon}
            {label}
            {count > 0 && (
              <span className={`text-[10px] rounded-full px-1.5 py-0.5 ${
                activeTab === key ? "bg-blue-50 text-blue-600" : "bg-zinc-100 text-zinc-500"
              }`}>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="px-0 py-3">
        {activeTab === "reviews" && (
          <div>
            {!showReviewForm && (
              <div className="flex justify-end mb-2.5">
                <button
                  onClick={() => setShowReviewForm(true)}
                  className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600 cursor-pointer"
                >
                  <Pen className="size-3" />
                  리뷰 쓰기
                </button>
              </div>
            )}

            {showReviewForm && (
              <div className="mb-3">
                <ReviewForm
                  key={reviewKey}
                  parkingLotId={lotId}
                  onSubmitted={refreshReviews}
                />
                <button
                  onClick={() => setShowReviewForm(false)}
                  className="mt-2 w-full text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  취소
                </button>
              </div>
            )}

            {userReviews.length > 0 ? (
              <div className="space-y-2.5">
                {userReviews.map((review) => (
                  <UserReviewCard
                    key={review.id}
                    review={review}
                    onDelete={
                      review.isMine
                        ? () => {
                            deleteReview({ data: { reviewId: review.id } })
                              .then(refreshReviews)
                              .catch(() => {});
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
            ) : (
              !showReviewForm && (
                <p className="text-xs text-muted-foreground text-center py-6">
                  아직 리뷰가 없습니다. 첫 리뷰를 남겨보세요!
                </p>
              )
            )}
          </div>
        )}

        {activeTab === "media" && (
          <div>
            {media.length > 0 ? (
              <div className="space-y-2.5">
                {media.map((m) => (
                  <a
                    key={m.id}
                    href={m.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex gap-2.5 rounded-lg border px-2 py-2 hover:bg-gray-50 transition-colors"
                  >
                    {m.thumbnailUrl && (
                      <img
                        src={m.thumbnailUrl}
                        alt=""
                        className="w-24 h-16 rounded object-cover shrink-0"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-gray-900 line-clamp-2 mb-1">
                        {m.title ? decodeHtmlEntities(m.title) : ""}
                      </p>
                      {m.description && (
                        <p className="text-[11px] text-muted-foreground line-clamp-2">
                          {decodeHtmlEntities(m.description)}
                        </p>
                      )}
                    </div>
                  </a>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-6">
                관련 영상이 없습니다
              </p>
            )}
          </div>
        )}

        {activeTab === "blog" && (
          <div>
            {blogPosts.length > 0 ? (
              <div className="space-y-2.5">
                {blogPosts.map((post) => (
                  <BlogPostCard key={post.sourceUrl} post={post} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-6">
                블로그 후기가 없습니다
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
