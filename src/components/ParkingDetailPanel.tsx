import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import type { ParkingLot, BlogPost, UserReview, ParkingMedia } from "@/types/parking";
import { fetchBlogPosts, fetchParkingMedia } from "@/server/parking";
import { fetchUserReviews, createReview, deleteReview } from "@/server/reviews";
import { VoteBookmarkBar } from "@/components/VoteBookmarkBar";
import { authClient } from "@/lib/auth-client";
import {
  getDifficultyIcon,
  getDifficultyLabel,
  getDistance,
} from "@/lib/geo-utils";
import { MapPin, Clock, CreditCard, Phone, ParkingSquare, X, MessageSquare, FileText, Star, User, Pen, Play, Flame, ThumbsUp } from "lucide-react";

interface ParkingDetailPanelProps {
  lot: ParkingLot;
  onClose: () => void;
  userLat?: number;
  userLng?: number;
  userLocated?: boolean;
}

/** 블로그 후기 스니펫 카드 */
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

/** 별점 입력 */
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


/** 리뷰 카드 */
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

/** 리뷰 작성 폼 — 별점 1개 + 한줄평 */
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

function difficultyColor(score: number | null) {
  if (score === null) return "bg-gray-400";
  if (score >= 4.0) return "bg-green-500";
  if (score >= 2.5) return "bg-yellow-500";
  if (score >= 1.5) return "bg-orange-500";
  return "bg-red-500";
}

export function ParkingDetailPanel({
  lot,
  onClose,
  userLat,
  userLng,
  userLocated,
}: ParkingDetailPanelProps) {
  const [blogPosts, setBlogPosts] = useState<BlogPost[]>([]);
  const [userReviews, setUserReviews] = useState<UserReview[]>([]);
  const [media, setMedia] = useState<ParkingMedia[]>([]);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewKey, setReviewKey] = useState(0);

  useEffect(() => {
    fetchBlogPosts({ data: { parkingLotId: lot.id } })
      .then(setBlogPosts)
      .catch(() => setBlogPosts([]));
    fetchUserReviews({ data: { parkingLotId: lot.id } })
      .then(setUserReviews)
      .catch(() => setUserReviews([]));
    fetchParkingMedia({ data: { parkingLotId: lot.id } })
      .then(setMedia)
      .catch(() => setMedia([]));
    setShowReviewForm(false);
  }, [lot.id]);

  const refreshReviews = () => {
    fetchUserReviews({ data: { parkingLotId: lot.id } })
      .then(setUserReviews)
      .catch(() => setUserReviews([]));
    setShowReviewForm(false);
    setReviewKey((k) => k + 1);
  };

  const icon = getDifficultyIcon(lot.difficulty.score);
  const label = getDifficultyLabel(lot.difficulty.score);
  const distance =
    userLocated && userLat && userLng
      ? getDistance(userLat, userLng, lot.lat, lot.lng)
      : null;

  return (
    <div className="hidden md:flex w-[360px] shrink-0 flex-col border-r bg-white animate-in slide-in-from-left-full duration-200">
      {/* 헤더 */}
      <div className="shrink-0 border-b px-4 py-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className={`size-3 rounded-full shrink-0 ${difficultyColor(lot.difficulty.score)}`}
            />
            <h2 className="font-semibold text-base truncate">{lot.name}</h2>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 p-1 rounded-md hover:bg-gray-100 transition-colors cursor-pointer"
          >
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {lot.curationTag === 'hell' && (
            <Badge variant="destructive" className="text-xs gap-1">
              <Flame className="size-3" />
              초보 주의
            </Badge>
          )}
          {lot.curationTag === 'easy' && (
            <Badge className="text-xs gap-1 bg-green-500 hover:bg-green-600">
              <ThumbsUp className="size-3" />
              초보 추천
            </Badge>
          )}
          <Badge variant="secondary" className="text-sm">
            {icon} {label}
          </Badge>
          <Badge variant={lot.pricing.isFree ? "default" : "outline"}>
            {lot.pricing.isFree ? "무료" : "유료"}
          </Badge>
          {distance !== null && (
            <span className="text-xs text-muted-foreground">
              {distance < 1
                ? `${Math.round(distance * 1000)}m`
                : `${distance.toFixed(1)}km`}
            </span>
          )}
          {lot.difficulty.reviewCount > 0 && (
            <span className="text-xs text-muted-foreground">
              리뷰 {lot.difficulty.reviewCount}개
            </span>
          )}
        </div>
        <div className="mt-2.5">
          <VoteBookmarkBar lotId={lot.id} />
        </div>
      </div>

      {/* 상세 정보 */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* 주소 */}
        <div className="flex items-start gap-2.5 text-sm">
          <MapPin className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
          <span>{lot.address}</span>
        </div>

        {/* 운영시간 */}
        <div className="flex items-start gap-2.5 text-sm">
          <Clock className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
          <div>
            <div>
              평일 {lot.operatingHours.weekday.start}-
              {lot.operatingHours.weekday.end}
            </div>
            <div className="text-xs text-muted-foreground">
              토 {lot.operatingHours.saturday.start}-
              {lot.operatingHours.saturday.end} · 공휴일{" "}
              {lot.operatingHours.holiday.start}-
              {lot.operatingHours.holiday.end}
            </div>
          </div>
        </div>

        {/* 요금 */}
        {!lot.pricing.isFree && (
          <div className="flex items-start gap-2.5 text-sm">
            <CreditCard className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
            <div>
              <div>
                기본 {lot.pricing.baseTime}분{" "}
                {lot.pricing.baseFee.toLocaleString()}원
              </div>
              <div className="text-xs text-muted-foreground">
                추가 {lot.pricing.extraTime}분당{" "}
                {lot.pricing.extraFee.toLocaleString()}원
                {lot.pricing.dailyMax &&
                  ` · 1일 최대 ${lot.pricing.dailyMax.toLocaleString()}원`}
              </div>
            </div>
          </div>
        )}

        {/* 주차면수 */}
        {lot.totalSpaces > 0 && (
          <div className="flex items-center gap-2.5 text-sm">
            <ParkingSquare className="size-4 shrink-0 text-muted-foreground" />
            <span>총 {lot.totalSpaces}면</span>
          </div>
        )}

        {/* 전화번호 */}
        {lot.phone && (
          <div className="flex items-center gap-2.5 text-sm">
            <Phone className="size-4 shrink-0 text-muted-foreground" />
            <a href={`tel:${lot.phone}`} className="text-blue-500 underline">
              {lot.phone}
            </a>
          </div>
        )}

        {/* 특기사항 */}
        {lot.notes && (
          <p className="text-xs text-muted-foreground bg-gray-50 rounded-lg px-3 py-2">
            {lot.notes}
          </p>
        )}

        {/* 큐레이션 사유 */}
        {lot.curationReason && (
          <div className={`text-xs rounded-lg px-3 py-2 ${
            lot.curationTag === 'hell'
              ? 'bg-red-50 text-red-700'
              : 'bg-green-50 text-green-700'
          }`}>
            {lot.curationTag === 'hell' ? '⚠️' : '✅'}{' '}
            {lot.curationReason}
          </div>
        )}

        {/* YouTube 영상 */}
        {media.length > 0 && (
          <div className="pt-2 border-t">
            <div className="flex items-center gap-2 mb-3">
              <Play className="size-4 text-muted-foreground" />
              <span className="font-medium text-sm">관련 영상</span>
              <span className="text-xs text-muted-foreground">
                {media.length}건
              </span>
            </div>
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
                      {m.title}
                    </p>
                    {m.description && (
                      <p className="text-[11px] text-muted-foreground line-clamp-2">
                        {m.description}
                      </p>
                    )}
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* 사용자 리뷰 */}
        <div className="pt-2 border-t">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <MessageSquare className="size-4 text-muted-foreground" />
              <span className="font-medium text-sm">난이도 리뷰</span>
              {userReviews.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {userReviews.length}건
                </span>
              )}
            </div>
            {!showReviewForm && (
              <button
                onClick={() => setShowReviewForm(true)}
                className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600 cursor-pointer"
              >
                <Pen className="size-3" />
                리뷰 쓰기
              </button>
            )}
          </div>

          {showReviewForm && (
            <div className="mb-3">
              <ReviewForm
                key={reviewKey}
                parkingLotId={lot.id}
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
              <p className="text-xs text-muted-foreground text-center py-4">
                아직 리뷰가 없습니다. 첫 리뷰를 남겨보세요!
              </p>
            )
          )}
        </div>

        {/* 블로그 후기 */}
        {blogPosts.length > 0 && (
          <div className="pt-2 border-t">
            <div className="flex items-center gap-2 mb-3">
              <FileText className="size-4 text-muted-foreground" />
              <span className="font-medium text-sm">블로그 후기</span>
              <span className="text-xs text-muted-foreground">
                {blogPosts.length}건
              </span>
            </div>
            <div className="space-y-2.5">
              {blogPosts.map((post) => (
                <BlogPostCard key={post.sourceUrl} post={post} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
