import { useEffect, useRef } from "react"
import type { TrajectoryEvent } from "../types"
import { Badge } from "./ui/badge"
import { screenshotUrl } from "../api"
import type { SelectedRun } from "./RunList"
import { ScreenshotWithMarker } from "./ClickMarker"
import { marksFromParams } from "../lib/clickMarks"
import type { LightboxTarget } from "./Lightbox"

function fmtTime(ts: string) {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return ts
  }
}

function actionColor(action: string | null) {
  switch (action) {
    case "click":
      return "bg-blue-500 text-white"
    case "type":
    case "key":
      return "bg-purple-500 text-white"
    case "scroll":
      return "bg-cyan-500 text-white"
    case "submit":
      return "bg-emerald-500 text-white"
    default:
      return "bg-slate-500 text-white"
  }
}

export function StepList({
  events,
  selected,
  onOpenImage,
}: {
  events: TrajectoryEvent[]
  selected: SelectedRun
  onOpenImage: (target: LightboxTarget) => void
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const lastCount = useRef(events.length)

  useEffect(() => {
    if (events.length > lastCount.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
    }
    lastCount.current = events.length
  }, [events.length])

  if (events.length === 0)
    return <div className="p-6 text-sm text-muted-foreground">No events yet.</div>

  return (
    <div className="divide-y">
      {events.map((ev, i) => {
        const isStart = ev.event_type === "run_start"
        const isEnd = ev.event_type === "run_end"
        let screenshotIdx: number | null
        if (isStart) {
          screenshotIdx = null
        } else if (isEnd) {
          // run_end carries no own screenshot — reuse the last tool_call's
          // post-action screenshot (the Submit / Correct! page).
          const prev = events[i - 1]
          screenshotIdx = prev && typeof prev.step === "number" ? prev.step + 1 : null
        } else {
          screenshotIdx = (ev.step ?? 0) + 1
        }
        const screenshotName = screenshotIdx != null ? `screenshot_step_${screenshotIdx}.png` : null
        return (
          <div key={`${ev.event_index}-${i}`} className="flex gap-3 p-3">
            <div className="w-14 shrink-0 text-xs text-muted-foreground tabular-nums pt-1">
              {isStart ? "—" : `#${ev.step}`}
              <div className="opacity-70 mt-0.5">{fmtTime(ev.timestamp)}</div>
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                {isStart ? (
                  <Badge variant="outline">run_start</Badge>
                ) : (
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${actionColor(
                      ev.action
                    )}`}
                  >
                    {ev.action ?? "?"}
                  </span>
                )}
                {ev.note && <Badge variant="secondary">{ev.note}</Badge>}
                {ev.params && Object.keys(ev.params).length > 0 && (
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                    {JSON.stringify(ev.params)}
                  </code>
                )}
              </div>

              {ev.result && (
                <div className="text-xs text-muted-foreground mb-1 break-words">→ {ev.result}</div>
              )}

              {isStart && ev.page_state?.prompt && (
                <div className="text-xs italic text-muted-foreground bg-muted/50 rounded p-2 mt-1">
                  {ev.page_state.prompt}
                </div>
              )}

              {screenshotName &&
                (() => {
                  const url = screenshotUrl(
                    selected.provider,
                    selected.model,
                    selected.task,
                    screenshotName
                  )
                  // Overlay this step's click on its post-action screenshot. Only
                  // tool_call rows carry params; run_start/run_end have none, so
                  // they render without a marker.
                  const { points, drags } = marksFromParams(
                    ev.action,
                    ev.params,
                    ev.step != null ? `#${ev.step}` : undefined
                  )
                  return (
                    <button
                      className="mt-2 inline-block"
                      onClick={() => onOpenImage({ src: url, points, drags })}
                    >
                      <ScreenshotWithMarker
                        src={url}
                        alt={screenshotName}
                        points={points}
                        drags={drags}
                        className="rounded border max-h-32 hover:max-h-48 transition-all"
                        onError={(e) => {
                          ;(e.currentTarget as HTMLImageElement).style.display = "none"
                        }}
                      />
                    </button>
                  )
                })()}
            </div>
          </div>
        )
      })}
      <div ref={endRef} />
    </div>
  )
}
