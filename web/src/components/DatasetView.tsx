import { useEffect, useMemo, useState } from "react"
import { fetchDataset, fetchDatasetItems } from "../api"
import type { DatasetIndex, DatasetItem } from "../types"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { ScrollArea } from "./ui/scroll-area"
import { Badge } from "./ui/badge"
import { cn } from "../lib/utils"
import { answerToTrajectory } from "../lib/answerToTrajectory"
import { TrajectoryPlayer } from "./TrajectoryPlayer"
import { PuzzleFrameModal } from "./PuzzleFrameModal"
import { LiveCaptchaFrame } from "./LiveCaptchaFrame"

interface SelectedType {
  split: string
  type: string
}

// Poll cadence for dataset content. The viewer is read-only, so frequent polls
// are cheap; this is what makes regenerated GT files show up without a manual
// page reload.
const DATASET_INDEX_INTERVAL = 10_000
const DATASET_ITEMS_INTERVAL = 5_000

export function DatasetView({ onOpenImage }: { onOpenImage: (src: string) => void }) {
  const [index, setIndex] = useState<DatasetIndex | null>(null)
  const [selected, setSelected] = useState<SelectedType | null>(null)
  const [items, setItems] = useState<DatasetItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Modal state — capture split+type at open time so it survives sidebar nav.
  const [livePreview, setLivePreview] = useState<{
    item: DatasetItem
    puzzleType: string
    split: string
  } | null>(null)

  // Index poll: picks up newly-generated splits / puzzle types.
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetchDataset()
        .then((d) => {
          if (cancelled) return
          setIndex(d)
          setSelected((cur) => {
            if (cur) return cur
            const firstSplit = d.splits[0]
            const firstType = firstSplit?.types.find((t) => t.count > 0) ?? firstSplit?.types[0]
            return firstSplit && firstType
              ? { split: firstSplit.split, type: firstType.type }
              : cur
          })
        })
        .catch((e) => !cancelled && setError(String(e)))
    load()
    const id = setInterval(load, DATASET_INDEX_INTERVAL)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // Items poll: re-reads ground_truth*.json so regenerated puzzles show up
  // automatically (no spinner on background refreshes).
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    let initial = true
    const load = () => {
      if (initial) setLoading(true)
      setError(null)
      fetchDatasetItems(selected.split, selected.type)
        .then((d) => !cancelled && setItems(d))
        .catch((e) => !cancelled && setError(String(e)))
        .finally(() => {
          if (!cancelled && initial) setLoading(false)
          initial = false
        })
    }
    load()
    const id = setInterval(load, DATASET_ITEMS_INTERVAL)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [selected])

  const samplePrompt = useMemo(() => {
    if (!index || !selected) return null
    return (
      index.splits
        .find((s) => s.split === selected.split)
        ?.types.find((t) => t.type === selected.type)?.prompt ?? null
    )
  }, [index, selected])

  return (
    <div className="flex-1 grid grid-cols-[280px_1fr] min-h-0">
      <ScrollArea className="border-r">
        {!index ? (
          <div className="p-4 text-sm text-muted-foreground">Loading…</div>
        ) : index.splits.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No dataset splits found.</div>
        ) : (
          <div className="space-y-3">
            {index.splits.map((s) => (
              <div key={s.split}>
                <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b">
                  {s.split}
                </div>
                <div>
                  {s.types.map((t) => {
                    const isSel = selected?.split === s.split && selected?.type === t.type
                    return (
                      <button
                        key={`${s.split}/${t.type}`}
                        onClick={() => setSelected({ split: s.split, type: t.type })}
                        disabled={t.count === 0}
                        className={cn(
                          "w-full text-left px-3 py-2 text-sm border-b hover:bg-accent transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed",
                          isSel && "bg-accent"
                        )}
                      >
                        <span className="flex-1 truncate" title={t.type}>
                          {t.type}
                        </span>
                        <span className="text-xs text-muted-foreground">{t.count}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      <div className="flex flex-col min-h-0">
        {!selected ? (
          <div className="m-auto text-muted-foreground">Select a category from the left.</div>
        ) : (
          <>
            <Card className="m-3 mb-0">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <CardTitle className="truncate">
                    {selected.split} / {selected.type}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{items.length} items</Badge>
                  </div>
                </div>
              </CardHeader>
              {samplePrompt && (
                <CardContent className="pt-0">
                  <p className="text-sm text-muted-foreground italic">{samplePrompt}</p>
                </CardContent>
              )}
            </Card>
            <ScrollArea className="flex-1 m-3">
              {error ? (
                <div className="p-4 text-sm text-red-600">{error}</div>
              ) : loading ? (
                <div className="p-4 text-sm text-muted-foreground">Loading items…</div>
              ) : items.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No items.</div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3 pr-3">
                  {items.map((it) => (
                    <DatasetCard
                      key={it.id}
                      item={it}
                      puzzleType={selected.type}
                      split={selected.split}
                      onOpenImage={onOpenImage}
                      onOpenLive={() =>
                        setLivePreview({
                          item: it,
                          puzzleType: selected.type,
                          split: selected.split,
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </ScrollArea>
          </>
        )}
      </div>

      <PuzzleFrameModal
        item={livePreview?.item ?? null}
        puzzleType={livePreview?.puzzleType ?? ""}
        split={livePreview?.split ?? ""}
        onClose={() => setLivePreview(null)}
        onOpenImage={onOpenImage}
      />
    </div>
  )
}

function DatasetCard({
  item,
  puzzleType,
  split,
  onOpenImage,
  onOpenLive,
}: {
  item: DatasetItem
  puzzleType: string
  split: string
  onOpenImage: (src: string) => void
  onOpenLive: () => void
}) {
  const [showRaw, setShowRaw] = useState(false)
  // Only Bingo defaults to the GT overlay (static thumbnail + the two swap-cell
  // dots) so its answer is checkable at a glance. Every other task keeps the
  // live rendered captcha as the default view.
  const isBingo = puzzleType.startsWith("Bingo")
  const [view, setView] = useState<"live" | "gt">(isBingo ? "gt" : "live")
  const trajectory = useMemo(
    () =>
      answerToTrajectory({
        answer_cu: item.answer_cu,
        answer_cu_kind: item.answer_cu_kind,
        answer: item.answer,
        viz_natural_xy: item.viz_natural_xy,
        grid_size: item.grid_size,
      }),
    [item]
  )

  const rawForDisplay = item.answer_cu ?? item.answer
  const rawText = useMemo(() => formatAnswerForDisplay(rawForDisplay), [rawForDisplay])

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-mono truncate flex-1" title={item.id}>
            {item.id}
          </div>
          {trajectory.kind && (
            <Badge
              variant={trajectory.spatial ? "secondary" : "outline"}
              className="text-[10px]"
              title={trajectory.summary}
            >
              {trajectory.spatial
                ? `${trajectory.steps.length}step · ${trajectory.kind}${
                    trajectory.alternatives ? ` · ${trajectory.alternatives.length} alts` : ""
                  }`
                : trajectory.kind}
            </Badge>
          )}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setView("live")}
              title="Show the real, rendered CAPTCHA task"
              className={cn(
                "text-[10px] uppercase tracking-wider px-2 py-1 rounded border transition-colors",
                view === "live" ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-accent"
              )}
            >
              Live
            </button>
            <button
              type="button"
              onClick={() => setView("gt")}
              title="Show the ground-truth trajectory overlay on the static image"
              className={cn(
                "text-[10px] uppercase tracking-wider px-2 py-1 rounded border transition-colors",
                view === "gt" ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-accent"
              )}
            >
              GT
            </button>
            <button
              type="button"
              onClick={onOpenLive}
              title="Open the live CAPTCHA page in a 1280×1080 interactive modal"
              className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border bg-background hover:bg-accent transition-colors"
            >
              ↗
            </button>
          </div>
        </div>

        {view === "live" ? (
          <LiveCaptchaFrame
            split={split}
            puzzleType={puzzleType}
            puzzleId={item.id}
            onExpand={onOpenLive}
          />
        ) : (
          <TrajectoryPlayer
            imageUrl={`${item.image_url}&thumb=1`}
            fullImageUrl={item.image_url}
            coordSize={
              trajectory.coordSize ??
              (item.natural_w && item.natural_h
                ? { w: item.natural_w, h: item.natural_h }
                : null)
            }
            steps={trajectory.steps}
            alternatives={trajectory.alternatives}
            needsSubmit={trajectory.needsSubmit}
            onOpenImage={onOpenImage}
            fallbackSummary={trajectory.summary}
            compact
          />
        )}

        {item.prompt && (
          <div className="text-xs text-muted-foreground line-clamp-3" title={item.prompt}>
            {item.prompt}
          </div>
        )}

        {rawForDisplay != null && (
          <div>
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              {showRaw ? "Hide raw answer" : "Show raw answer"}
            </button>
            {showRaw && (
              <pre className="mt-1 text-[11px] bg-muted p-2 rounded max-h-40 overflow-auto whitespace-pre-wrap break-words">
                {rawText}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Stringify an answer for the "Show raw answer" panel using a layout that
 * mirrors how the GT files are written: primitive arrays inlined ([0, 7]),
 * tool-call objects (`{"action": ..., "arguments": {...}}`) inlined onto a
 * single line, everything else expanded with 2-space indent.
 */
function formatAnswerForDisplay(value: unknown): string {
  return formatNode(value, 0)
}

function formatNode(value: unknown, depth: number): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  const pad = "  ".repeat(depth)
  const padIn = "  ".repeat(depth + 1)

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    if (value.every((v) => v === null || typeof v !== "object")) {
      return "[" + value.map((v) => JSON.stringify(v)).join(", ") + "]"
    }
    const parts = value.map((v) => padIn + formatNode(v, depth + 1))
    return "[\n" + parts.join(",\n") + "\n" + pad + "]"
  }

  // Object: inline if it's a known tool-call shape or an {x, y} dict.
  const keys = Object.keys(value as object)
  const obj = value as Record<string, unknown>
  const isXY =
    keys.length === 2 && keys.every((k) => k === "x" || k === "y") &&
    typeof obj.x === "number" && typeof obj.y === "number"
  const isCall =
    "arguments" in obj && ("action" in obj || "name" in obj) &&
    typeof obj.arguments === "object" && obj.arguments !== null
  if (isXY || isCall) {
    const parts = keys.map((k) => `"${k}": ${formatNode(obj[k], depth + 1)}`)
    return "{" + parts.join(", ") + "}"
  }

  if (keys.length === 0) return "{}"
  const parts = keys.map((k) => padIn + `"${k}": ${formatNode(obj[k], depth + 1)}`)
  return "{\n" + parts.join(",\n") + "\n" + pad + "}"
}
