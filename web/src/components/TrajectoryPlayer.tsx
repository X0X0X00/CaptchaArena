import { useEffect, useRef, useState } from "react"
import type { TrajectoryStep } from "../lib/answerToTrajectory"
import { cn } from "../lib/utils"

interface Props {
  imageUrl: string
  /** Full-resolution URL for the lightbox; defaults to imageUrl. Pass this when
   *  imageUrl is a thumbnail so zooming opens the original. */
  fullImageUrl?: string
  /** Coordinate frame of `steps` in original-image pixels. Required when
   *  imageUrl is a thumbnail — the rendered naturalWidth is the thumb's, not
   *  the original's, and overlay scaling would be wrong without this. */
  coordSize?: { w: number; h: number } | null
  steps: TrajectoryStep[]
  /**
   * When the puzzle has multiple equally-valid solutions, pass each as its own
   * step list. The player shows a switcher and renders one alternative at a
   * time. `steps` should equal `alternatives[0]` for backwards compatibility.
   */
  alternatives?: TrajectoryStep[][]
  /** When true, append a "+ click submit" hint after the last step. */
  needsSubmit?: boolean
  onOpenImage?: (src: string) => void
  /** Caption shown below image when there are no spatial steps (e.g. "type 24"). */
  fallbackSummary?: string
  /** Frame interval in ms when playing. */
  intervalMs?: number
  /** Show a compact control bar (for grid cards). */
  compact?: boolean
}

export function TrajectoryPlayer({
  imageUrl,
  fullImageUrl,
  coordSize,
  steps,
  alternatives,
  needsSubmit,
  onOpenImage,
  fallbackSummary,
  intervalMs = 1000,
  compact = false,
}: Props) {
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [altIdx, setAltIdx] = useState(0)

  const activeSteps = alternatives && alternatives.length > 0 ? alternatives[altIdx] ?? steps : steps

  // Current step index. -1 means "before any step" (image only).
  const [idx, setIdx] = useState<number>(activeSteps.length > 0 ? 0 : -1)
  const [playing, setPlaying] = useState(false)

  // Clamp altIdx when alternatives count changes (e.g. navigating to a different
  // puzzle). Keep the user's selection if it's still in range — polling renders
  // hand us a new `alternatives` reference identity every few seconds even when
  // the content is unchanged, and we don't want to snap back to #1 then.
  const altCount = alternatives?.length ?? 0
  useEffect(() => {
    setAltIdx((prev) => (altCount > 0 && prev < altCount ? prev : 0))
  }, [altCount])

  // Reset step index when switching alternative within the same puzzle, or when
  // the puzzle itself changes (detected via step count, not reference identity).
  const stepCount = activeSteps.length
  useEffect(() => {
    setIdx(stepCount > 0 ? 0 : -1)
    setPlaying(false)
  }, [altIdx, stepCount])

  useEffect(() => {
    if (!playing || activeSteps.length === 0) return
    const t = setInterval(() => {
      setIdx((i) => {
        if (i + 1 >= activeSteps.length) {
          setPlaying(false)
          return i
        }
        return i + 1
      })
    }, intervalMs)
    return () => clearInterval(t)
  }, [playing, activeSteps, intervalMs])

  const onImgLoad = () => {
    const im = imgRef.current
    if (!im) return
    setNatural({ w: im.naturalWidth, h: im.naturalHeight })
  }

  const hasSteps = activeSteps.length > 0
  const safeIdx = Math.min(Math.max(idx, 0), activeSteps.length - 1)
  const hasAlts = !!alternatives && alternatives.length > 1

  return (
    <div className="space-y-2">
      <div className="relative bg-muted rounded overflow-hidden select-none">
        <img
          ref={imgRef}
          src={imageUrl}
          alt="puzzle"
          loading="lazy"
          onLoad={onImgLoad}
          onClick={() => onOpenImage?.(fullImageUrl ?? imageUrl)}
          className="block w-full h-auto cursor-zoom-in"
        />
        {(coordSize ?? natural) && hasSteps && (
          <Overlay steps={activeSteps} currentIdx={idx} natural={(coordSize ?? natural)!} />
        )}
      </div>

      {hasAlts && (
        <div className="flex items-center gap-1 text-[11px] flex-wrap">
          <span className="text-muted-foreground">Valid answers:</span>
          {alternatives!.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setAltIdx(i)}
              className={cn(
                "px-2 py-0.5 rounded border transition-colors",
                i === altIdx
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background hover:bg-accent"
              )}
              title={`Alternative ${i + 1}`}
            >
              #{i + 1}
            </button>
          ))}
        </div>
      )}

      {hasSteps ? (
        <div
          className={cn(
            "flex items-center gap-1 text-xs",
            compact ? "flex-wrap" : "flex-wrap"
          )}
        >
          <button
            type="button"
            onClick={() => {
              if (idx >= activeSteps.length - 1) setIdx(0)
              setPlaying((p) => !p)
            }}
            className="px-2 py-1 rounded border bg-background hover:bg-accent"
            title="Play / Pause"
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            type="button"
            onClick={() => {
              setPlaying(false)
              setIdx((i) => Math.max(0, i - 1))
            }}
            disabled={idx <= 0}
            className="px-2 py-1 rounded border bg-background hover:bg-accent disabled:opacity-40"
            title="Previous step"
          >
            ◀
          </button>
          <button
            type="button"
            onClick={() => {
              setPlaying(false)
              setIdx((i) => Math.min(activeSteps.length - 1, i + 1))
            }}
            disabled={idx >= activeSteps.length - 1}
            className="px-2 py-1 rounded border bg-background hover:bg-accent disabled:opacity-40"
            title="Next step"
          >
            ▶
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(0, activeSteps.length - 1)}
            value={safeIdx}
            onChange={(e) => {
              setPlaying(false)
              setIdx(Number(e.target.value))
            }}
            className="flex-1 min-w-[60px] accent-primary"
          />
          <span className="text-muted-foreground tabular-nums">
            {safeIdx + 1}/{activeSteps.length}
          </span>
        </div>
      ) : (
        fallbackSummary && (
          <p className="text-[11px] text-muted-foreground italic">{fallbackSummary}</p>
        )
      )}

      {hasSteps && activeSteps[safeIdx] && (
        <StepCaption step={activeSteps[safeIdx]} />
      )}
      {needsSubmit && hasSteps && (
        <div className="text-[11px] text-muted-foreground italic">
          + click <span className="font-semibold text-foreground">Submit</span> after
        </div>
      )}
    </div>
  )
}

function Overlay({
  steps,
  currentIdx,
  natural,
}: {
  steps: TrajectoryStep[]
  currentIdx: number
  natural: { w: number; h: number }
}) {
  const toPct = (x: number, y: number) => ({
    left: `${(x / natural.w) * 100}%`,
    top: `${(y / natural.h) * 100}%`,
  })

  // Path connecting click centres in order, dimmed beyond currentIdx
  const pointSteps = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => typeof s.x === "number" && typeof s.y === "number")
  const pathPoints = pointSteps.map(({ s }) => `${(s.x! / natural.w) * 100},${(s.y! / natural.h) * 100}`)

  return (
    <div className="absolute inset-0 pointer-events-none">
      {(pathPoints.length >= 2 || steps.some((s) => s.type === "drag")) && (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full"
        >
          {pathPoints.length >= 2 && (
            <polyline
              points={pathPoints.join(" ")}
              fill="none"
              stroke="rgb(99 102 241 / 0.55)"
              strokeWidth="0.4"
              strokeDasharray="1.2 0.8"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <defs>
            <marker
              id="trajArrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="4"
              markerHeight="4"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(244 63 94)" />
            </marker>
          </defs>
          {steps.map((s, i) => {
            if (
              s.type !== "drag" ||
              s.fromX == null ||
              s.fromY == null ||
              s.toX == null ||
              s.toY == null
            )
              return null
            const x1 = (s.fromX / natural.w) * 100
            const y1 = (s.fromY / natural.h) * 100
            const x2 = (s.toX / natural.w) * 100
            const y2 = (s.toY / natural.h) * 100
            const isCurrent = i === currentIdx
            return (
              <line
                key={`drag-${i}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="rgb(244 63 94)"
                strokeWidth={isCurrent ? "0.7" : "0.4"}
                strokeOpacity={isCurrent ? 1 : 0.5}
                vectorEffect="non-scaling-stroke"
                markerEnd="url(#trajArrow)"
              />
            )
          })}
        </svg>
      )}

      {steps.map((s, i) => {
        if (typeof s.x !== "number" || typeof s.y !== "number") return null
        const isCurrent = i === currentIdx
        const isPast = i < currentIdx
        return (
          <div
            key={`pt-${i}`}
            style={{ ...toPct(s.x, s.y), transform: "translate(-50%, -50%)" }}
            className={cn(
              "absolute flex items-center justify-center rounded-full text-[10px] font-bold shadow-lg transition-all border-2",
              isCurrent
                ? "h-6 w-6 bg-rose-500 text-white border-white animate-pulse"
                : isPast
                  ? "h-4 w-4 bg-rose-500/70 text-white border-white/80"
                  : "h-4 w-4 bg-rose-500/30 text-white/80 border-white/50"
            )}
            title={s.label}
          >
            {s.label}
          </div>
        )
      })}
    </div>
  )
}

function StepCaption({ step }: { step: TrajectoryStep }) {
  const coords =
    step.x != null && step.y != null
      ? `(${Math.round(step.x)}, ${Math.round(step.y)})`
      : null
  return (
    <div className="text-[11px] text-muted-foreground">
      <span className="font-semibold text-foreground">{step.type}</span>
      {coords && <span className="ml-1 font-mono">{coords}</span>}
      {step.note && <span className="ml-1">— {step.note}</span>}
    </div>
  )
}
