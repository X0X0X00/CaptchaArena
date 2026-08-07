import { useEffect, useMemo, useRef, useState } from "react"
import { fetchRuns, fetchTrajectory } from "./api"
import type { RunsResponse, TrajectoryEvent } from "./types"
import { RunList, type SelectedRun } from "./components/RunList"
import { StepList } from "./components/StepList"
import { Lightbox, type LightboxTarget } from "./components/Lightbox"
import { StatusBadge } from "./components/StatusBadge"
import { DatasetView } from "./components/DatasetView"
import { SftView } from "./components/SftView"
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card"
import { ScrollArea } from "./components/ui/scroll-area"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { RefreshCw } from "lucide-react"

type View = "runs" | "dataset" | "sft"

const RUNS_INTERVAL = 5000
const TRAJ_INTERVAL = 2000

export default function App() {
  // Default to the SFT tab: it's fast (cheap per-file cache), whereas the Runs
  // tab walks 10k+ Output dirs over NFS (~11s cold) and would otherwise spin on
  // every fresh page load. Runs is one click away when you actually want it.
  const [view, setView] = useState<View>("sft")
  const [runs, setRuns] = useState<RunsResponse | null>(null)
  const [selected, setSelected] = useState<SelectedRun | null>(null)
  const [events, setEvents] = useState<TrajectoryEvent[]>([])
  const [lightbox, setLightbox] = useState<LightboxTarget | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  // Resizable left sidebar (Output Runs). Fixed 320px truncated long model/task
  // names; drag the divider to widen. Persisted in localStorage.
  const [leftW, setLeftW] = useState<number>(() => {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem("runsLeftW") : null
    const n = v ? parseInt(v, 10) : 320
    return Number.isFinite(n) ? Math.min(720, Math.max(200, n)) : 320
  })
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = leftW
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(720, Math.max(200, startW + ev.clientX - startX))
      setLeftW(w)
      try { localStorage.setItem("runsLeftW", String(w)) } catch { /* ignore */ }
    }
    const onUp = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      document.body.style.cursor = ""
    }
    document.body.style.cursor = "col-resize"
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  useEffect(() => {
    if (view !== "runs") return
    let cancelled = false
    const load = async () => {
      try {
        const data = await fetchRuns()
        if (!cancelled) {
          setRuns(data)
          setError(null)
          if (!selectedRef.current) {
            const first =
              data.providers[0]?.models[0]?.splits[0]?.puzzle_types[0]?.tasks[0]
            if (first)
              setSelected({
                provider: first.provider,
                model: first.model,
                task: first.task_path,
              })
          }
        }
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    }
    load()
    if (!autoRefresh) {
      return () => {
        cancelled = true
      }
    }
    const id = setInterval(load, RUNS_INTERVAL)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [autoRefresh, view])

  useEffect(() => {
    if (view !== "runs" || !selected) return
    let cancelled = false
    const load = async () => {
      try {
        const data = await fetchTrajectory(selected.provider, selected.model, selected.task)
        if (!cancelled) setEvents(data)
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    }
    load()
    if (!autoRefresh) {
      return () => {
        cancelled = true
      }
    }
    const id = setInterval(load, TRAJ_INTERVAL)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [selected, autoRefresh, view])

  const currentTaskInfo = useMemo(() => {
    if (!runs || !selected) return null
    for (const p of runs.providers) {
      if (p.provider !== selected.provider) continue
      for (const m of p.models) {
        if (m.model !== selected.model) continue
        for (const sp of m.splits) {
          for (const pt of sp.puzzle_types) {
            const hit = pt.tasks.find((t) => t.task_path === selected.task)
            if (hit) return hit
          }
        }
      }
    }
    return null
  }, [runs, selected])

  const totalAcrossAll = useMemo(() => {
    if (!runs) return null
    let total = 0
    let correct = 0
    let submitted = 0
    for (const p of runs.providers) {
      for (const m of p.models) {
        for (const sp of m.splits) {
          for (const pt of sp.puzzle_types) {
            for (const t of pt.tasks) {
              total++
              if (t.correct) correct++
              if (t.submitted) submitted++
            }
          }
        }
      }
    }
    return { total, correct, submitted }
  }, [runs])

  const goalText = useMemo(() => {
    const start = events.find((e) => e.event_type === "run_start")
    return start?.page_state?.prompt ?? null
  }, [events])

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="border-b px-4 py-3 flex items-center gap-4">
        <h1 className="text-lg font-semibold">CAPTCHA Agent Trajectory Viewer</h1>
        <div className="inline-flex rounded-md border overflow-hidden">
          <button
            type="button"
            onClick={() => setView("runs")}
            className={`px-3 py-1 text-sm transition-colors ${view === "runs" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-accent"}`}
          >
            Output Runs
          </button>
          <button
            type="button"
            onClick={() => setView("dataset")}
            className={`px-3 py-1 text-sm border-l transition-colors ${view === "dataset" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-accent"}`}
          >
            Dataset
          </button>
          <button
            type="button"
            onClick={() => setView("sft")}
            className={`px-3 py-1 text-sm border-l transition-colors ${view === "sft" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-accent"}`}
          >
            SFT
          </button>
        </div>
        {view === "runs" && totalAcrossAll && (
          <div className="text-sm text-muted-foreground">
            Total: <span className="font-medium text-foreground">{totalAcrossAll.total}</span> ·
            Submitted: <span className="font-medium text-foreground">{totalAcrossAll.submitted}</span> ·
            Correct: <span className="font-medium text-emerald-600">{totalAcrossAll.correct}</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {error && (
            <Badge variant="destructive" title={error}>
              {error.slice(0, 40)}
            </Badge>
          )}
          {view === "runs" && (
            <Button
              variant={autoRefresh ? "default" : "outline"}
              size="sm"
              onClick={() => setAutoRefresh((v) => !v)}
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${autoRefresh ? "animate-spin" : ""}`} />
              {autoRefresh ? "Auto" : "Paused"}
            </Button>
          )}
        </div>
      </header>

      {view === "runs" ? (
        <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: `${leftW}px 6px 1fr` }}>
          <ScrollArea className="border-r">
            <RunList data={runs} selected={selected} onSelect={setSelected} />
          </ScrollArea>

          <div
            onMouseDown={startResize}
            title="拖动调整宽度 · drag to resize"
            className="cursor-col-resize bg-border hover:bg-primary/50 transition-colors"
          />

          <div className="flex flex-col min-h-0">
            {selected && currentTaskInfo ? (
              <>
                <Card className="m-3 mb-0">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <CardTitle className="truncate">{selected.task}</CardTitle>
                      <div className="flex items-center gap-2">
                        <StatusBadge
                          submitted={currentTaskInfo.submitted}
                          correct={currentTaskInfo.correct}
                          status={currentTaskInfo.status}
                        />
                        {currentTaskInfo.puzzle_type && (
                          <Badge variant="outline">{currentTaskInfo.puzzle_type}</Badge>
                        )}
                        {currentTaskInfo.reward != null && (
                          <Badge variant="secondary">reward: {currentTaskInfo.reward}</Badge>
                        )}
                        {currentTaskInfo.total_steps != null && (
                          <Badge variant="secondary">steps: {currentTaskInfo.total_steps}</Badge>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  {goalText && (
                    <CardContent className="pt-0">
                      <p className="text-sm text-muted-foreground italic">{goalText}</p>
                    </CardContent>
                  )}
                </Card>
                <ScrollArea className="flex-1 m-3">
                  <StepList events={events} selected={selected} onOpenImage={setLightbox} />
                </ScrollArea>
              </>
            ) : (
              <div className="m-auto text-muted-foreground">Select a run from the left.</div>
            )}
          </div>
        </div>
      ) : view === "dataset" ? (
        <DatasetView onOpenImage={setLightbox} />
      ) : (
        <SftView onOpenImage={setLightbox} />
      )}

      <Lightbox src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}
