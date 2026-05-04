import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fetchVoteSummary, toggleVote, type VoteSummary } from '@/server/votes'

export function VoteBookmarkBar({ lotId }: { lotId: string }) {
  const [summary, setSummary] = useState<VoteSummary>({
    upCount: 0,
    downCount: 0,
    myVote: null,
    bookmarked: false,
  })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetchVoteSummary({ data: { parkingLotId: lotId } })
      .then(setSummary)
      .catch(() => {})
  }, [lotId])

  const handleVote = async (voteType: 'up' | 'down') => {
    if (loading) return
    setLoading(true)

    setSummary((prev) => {
      const wasVoted = prev.myVote === voteType
      const wasOther = prev.myVote !== null && prev.myVote !== voteType
      return {
        ...prev,
        myVote: wasVoted ? null : voteType,
        upCount:
          voteType === 'up'
            ? prev.upCount + (wasVoted ? -1 : 1)
            : prev.upCount + (wasOther && prev.myVote === 'up' ? -1 : 0),
        downCount:
          voteType === 'down'
            ? prev.downCount + (wasVoted ? -1 : 1)
            : prev.downCount + (wasOther && prev.myVote === 'down' ? -1 : 0),
      }
    })

    try {
      await toggleVote({ data: { parkingLotId: lotId, voteType } })
    } catch {
      const fresh = await fetchVoteSummary({ data: { parkingLotId: lotId } })
      setSummary(fresh)
    } finally {
      setLoading(false)
    }
  }

  return (
    <fieldset className="inline-flex h-10 shrink-0 overflow-hidden rounded-full border bg-background shadow-xs">
      <legend className="sr-only">주차 난이도 투표</legend>
      <button
        type="button"
        onClick={() => handleVote('up')}
        title="주차 쉬워요"
        className={`inline-flex min-w-12 items-center justify-center gap-1 border-r px-3 text-sm font-medium transition-colors cursor-pointer ${
          summary.myVote === 'up'
            ? 'bg-green-100 text-green-700'
            : 'bg-background text-gray-600 hover:bg-gray-50'
        }`}
      >
        <ThumbsUp className={`size-4 ${summary.myVote === 'up' ? 'fill-green-500' : ''}`} />
        {summary.upCount > 0 && <span>{summary.upCount}</span>}
      </button>
      <button
        type="button"
        onClick={() => handleVote('down')}
        title="주차 어려워요"
        className={`inline-flex min-w-12 items-center justify-center gap-1 px-3 text-sm font-medium transition-colors cursor-pointer ${
          summary.myVote === 'down'
            ? 'bg-red-100 text-red-700'
            : 'bg-background text-gray-600 hover:bg-gray-50'
        }`}
      >
        <ThumbsDown className={`size-4 ${summary.myVote === 'down' ? 'fill-red-500' : ''}`} />
        {summary.downCount > 0 && <span>{summary.downCount}</span>}
      </button>
    </fieldset>
  )
}
