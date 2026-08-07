import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { DatasetItem } from "../types"
import { TrajectoryPlayer } from "./TrajectoryPlayer"
import { answerToTrajectory } from "../lib/answerToTrajectory"
import { Badge } from "./ui/badge"
import { cn } from "../lib/utils"
import { CAPTCHA_SERVER_URL } from "./LiveCaptchaFrame"

// Canonical agent viewport — keep in sync with computeruse_cli.DEFAULT_WIDTH/HEIGHT
// so the modal renders the puzzle exactly the way the model sees it.
const VIEWPORT_W = 1280
const VIEWPORT_H = 1080

type PlayStatus = "idle" | "ready" | "playing" | "done" | "error"

interface Props {
  item: DatasetItem | null
  /** Puzzle type captured at the moment the modal was opened, so it survives
   *  sidebar changes while open. */
  puzzleType: string
  split: string
  onClose: () => void
  onOpenImage?: (src: string) => void
}

export function PuzzleFrameModal({ item, puzzleType, split, onClose, onOpenImage }: Props) {
  useEffect(() => {
    if (!item) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [item, onClose])

  const stageRef = useRef<HTMLDivElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [scale, setScale] = useState(1)
  const [status, setStatus] = useState<PlayStatus>("idle")
  const [statusMsg, setStatusMsg] = useState<string>("")
  const [altIndex, setAltIndex] = useState(0)
  // Inter-step delay in ms — longer makes the playback easier to follow on
  // option-cycling puzzles where many consecutive arrow clicks otherwise blur
  // together. Stored locally so the choice survives across alt switches.
  const [stepDelay, setStepDelay] = useState(1000)
  // Bumping this forces React to recreate the iframe element (and hence reset
  // the live page). Used by the Reload button.
  const [iframeKey, setIframeKey] = useState(0)

  // Auto-scale the 1280×1080 frame into the available stage area while
  // preserving aspect ratio. The iframe always renders at the canonical size
  // logically so CSS / layout inside the page match the agent's view exactly.
  useLayoutEffect(() => {
    if (!item) return
    const stage = stageRef.current
    if (!stage) return
    const compute = () => {
      const rect = stage.getBoundingClientRect()
      const pad = 24
      const s = Math.min(
        (rect.width - pad) / VIEWPORT_W,
        (rect.height - pad) / VIEWPORT_H,
        1
      )
      setScale(s > 0 ? s : 1)
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [item])

  // Reset status when the puzzle changes or the iframe is reloaded.
  useEffect(() => {
    setStatus("idle")
    setStatusMsg("")
    setAltIndex(0)
  }, [item, iframeKey])

  // Listen for cu_ready / cu_play_* messages from the iframe.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // Only accept from our iframe's window. Origin will be the Flask host.
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return
      const data = e.data
      if (!data || typeof data !== "object") return
      switch (data.type) {
        case "cu_ready":
          setStatus((s) => (s === "playing" ? s : "ready"))
          break
        case "cu_play_start":
          setStatus("playing")
          setStatusMsg(`playing ${data.kind ?? ""}`)
          break
        case "cu_play_step":
          setStatusMsg(`step ${data.step}/${data.total}`)
          break
        case "cu_play_done":
          setStatus("done")
          setStatusMsg("done")
          break
        case "cu_play_error":
          setStatus("error")
          setStatusMsg(String(data.error || "error"))
          break
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [])

  const trajectory = useMemo(() => {
    if (!item) return null
    return answerToTrajectory({
      answer_cu: item.answer_cu,
      answer_cu_kind: item.answer_cu_kind,
      answer: item.answer,
      viz_natural_xy: item.viz_natural_xy,
    })
  }, [item])

  const playGt = useCallback(() => {
    if (!item || !iframeRef.current?.contentWindow || !trajectory) return
    iframeRef.current.contentWindow.postMessage(
      {
        type: "cu_play_gt",
        answer_cu: item.answer_cu,
        kind: trajectory.kind,
        alt_index: altIndex,
        step_delay: stepDelay,
      },
      "*"
    )
    setStatus("playing")
    setStatusMsg("sent…")
  }, [item, trajectory, altIndex, stepDelay])

  const reloadIframe = useCallback(() => {
    setIframeKey((k) => k + 1)
  }, [])

  if (!item || !trajectory) return null

  const params = new URLSearchParams({
    single_puzzle: "true",
    puzzle_type: puzzleType,
    puzzle_id: item.id,
    split,  // app.py scopes file lookup to data/<split>/ for this request
  })
  const iframeSrc = `${CAPTCHA_SERVER_URL}/?${params.toString()}`

  const playable = status === "ready" || status === "done" || status === "error"
  const playLabel =
    status === "playing"
      ? `Playing… ${statusMsg}`
      : status === "done"
        ? "Replay GT"
        : status === "error"
          ? "Retry"
          : "Play GT on live page ▶"

  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex p-4"
      onClick={onClose}
    >
      <div
        className="flex-1 flex flex-col bg-background rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-2 border-b">
          <Badge variant="outline">{split}</Badge>
          <Badge variant="outline">{puzzleType}</Badge>
          <code className="text-sm font-mono">{item.id}</code>
          {trajectory.kind && (
            <Badge variant="secondary" className="text-[10px]" title={trajectory.summary}>
              {trajectory.spatial
                ? `${trajectory.steps.length}step · ${trajectory.kind}${
                    trajectory.alternatives ? ` · ${trajectory.alternatives.length} alts` : ""
                  }`
                : trajectory.kind}
            </Badge>
          )}
          <PlayStatusPill status={status} message={statusMsg} />

          <div className="ml-auto flex items-center gap-2">
            {trajectory.alternatives && trajectory.alternatives.length > 1 && (
              <div className="flex items-center gap-1 text-[11px]">
                <span className="text-muted-foreground">alt</span>
                {trajectory.alternatives.map((alt, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setAltIndex(i)}
                    title={`Alternative ${i + 1} · ${alt.length} step${alt.length === 1 ? "" : "s"}`}
                    className={cn(
                      "px-2 py-0.5 rounded border",
                      i === altIndex
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background hover:bg-accent"
                    )}
                  >
                    #{i + 1}
                    {alt.length > 0 && (
                      <span className="ml-1 text-muted-foreground">({alt.length})</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1 text-[11px]" title="Inter-step delay during playback">
              <span className="text-muted-foreground">speed</span>
              <input
                type="range"
                min={200}
                max={2500}
                step={100}
                value={stepDelay}
                onChange={(e) => setStepDelay(Number(e.target.value))}
                className="w-24 accent-primary"
              />
              <span className="font-mono text-muted-foreground tabular-nums w-12 text-right">
                {stepDelay}ms
              </span>
            </div>
            <button
              type="button"
              onClick={playGt}
              disabled={!playable}
              className={cn(
                "text-xs px-3 py-1 rounded border transition-colors",
                playable
                  ? "bg-primary text-primary-foreground border-primary hover:bg-primary/90"
                  : "opacity-50 cursor-not-allowed"
              )}
              title={
                playable
                  ? "Send the GT trajectory to the iframe; it will click + submit"
                  : "Waiting for the live page to be ready"
              }
            >
              {playLabel}
            </button>
            <button
              type="button"
              onClick={reloadIframe}
              className="text-xs px-3 py-1 rounded border hover:bg-accent"
              title="Reload the iframe (resets the puzzle)"
            >
              Reload ↻
            </button>
            <a
              href={iframeSrc}
              target="_blank"
              rel="noreferrer"
              className="text-xs px-3 py-1 rounded border hover:bg-accent"
            >
              New tab ↗
            </a>
            <button
              type="button"
              onClick={onClose}
              className="text-sm px-3 py-1 rounded border hover:bg-accent"
              aria-label="Close"
            >
              Close ✕
            </button>
          </div>
        </div>

        <div className="flex-1 grid grid-cols-[1fr_360px] min-h-0">
          <div
            ref={stageRef}
            className="relative bg-zinc-900 flex items-center justify-center overflow-hidden"
          >
            <div
              style={{
                width: VIEWPORT_W,
                height: VIEWPORT_H,
                transform: `scale(${scale})`,
                transformOrigin: "center center",
              }}
              className="bg-white shadow-xl shrink-0"
            >
              <iframe
                key={iframeKey}
                ref={iframeRef}
                src={iframeSrc}
                title={`${puzzleType}/${item.id}`}
                width={VIEWPORT_W}
                height={VIEWPORT_H}
                className="block border-0 bg-white"
              />
            </div>
            <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between text-[10px] text-white/70 font-mono">
              <span className="bg-black/50 px-2 py-0.5 rounded">
                {VIEWPORT_W}×{VIEWPORT_H} · scale {(scale * 100).toFixed(0)}%
              </span>
              <span className="bg-black/50 px-2 py-0.5 rounded truncate max-w-[60%]">
                {iframeSrc}
              </span>
            </div>
          </div>

          <div className="border-l flex flex-col min-h-0 overflow-auto">
            <div className="p-3 space-y-3">
              {item.prompt && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    Prompt
                  </div>
                  <p className="text-sm">{item.prompt}</p>
                </div>
              )}

              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                  Ground-truth trajectory
                </div>
                <TrajectoryPlayer
                  imageUrl={item.image_url}
                  steps={trajectory.steps}
                  alternatives={trajectory.alternatives}
                  needsSubmit={trajectory.needsSubmit}
                  onOpenImage={onOpenImage}
                  fallbackSummary={trajectory.summary}
                  compact
                />
              </div>

              <div className="text-[11px] text-muted-foreground border-t pt-2 leading-relaxed">
                <p>
                  <span className="font-semibold text-foreground">Play GT</span> dispatches the
                  ground-truth actions on the iframe page — image clicks (with submit), arrow
                  navigation for option-type puzzles, text input for Dice_Count, rotate / hold /
                  drag. The page then auto-submits or you'll see the final Submit click happen.
                </p>
                <p className="mt-1">
                  The iframe URL carries{" "}
                  <code className="font-mono">?split={split}</code>, so{" "}
                  <code className="font-mono">app.py</code> resolves puzzle files under{" "}
                  <code className="font-mono">data/{split}/</code> for this request — no need to
                  restart the server when switching splits.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function PlayStatusPill({ status, message }: { status: PlayStatus; message: string }) {
  if (status === "idle") {
    return (
      <span className="text-[10px] text-muted-foreground italic">loading iframe…</span>
    )
  }
  const cls =
    status === "ready"
      ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/30"
      : status === "playing"
        ? "bg-amber-500/15 text-amber-700 border-amber-500/30 animate-pulse"
        : status === "done"
          ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/30"
          : "bg-rose-500/15 text-rose-700 border-rose-500/30"
  return (
    <span
      className={cn(
        "text-[10px] px-2 py-0.5 rounded border font-mono",
        cls
      )}
      title={message}
    >
      {status}
      {message ? ` · ${message}` : ""}
    </span>
  )
}
