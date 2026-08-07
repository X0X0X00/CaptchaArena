import { useEffect, useMemo, useState } from "react"
import type { RunsResponse, RunInfo, SplitGroup, PuzzleTypeGroup } from "../types"
import { StatusBadge } from "./StatusBadge"
import { cn } from "../lib/utils"
import { ChevronDown, ChevronRight } from "lucide-react"

export interface SelectedRun {
  provider: string
  model: string
  /** Full relative path under `<provider>/<model>/` — may contain slashes. */
  task: string
}

type SummaryStats = { total?: number; correct?: number; accuracy?: number | null }

function readStats(summary: unknown): SummaryStats | null {
  if (!summary || typeof summary !== "object") return null
  const s = summary as { total_puzzles?: number; total_correct?: number; accuracy?: number }
  if (s.total_puzzles == null && s.accuracy == null) return null
  return {
    total: s.total_puzzles,
    correct: s.total_correct,
    accuracy: s.accuracy ?? null,
  }
}

function Stats({ stats }: { stats: SummaryStats | null }) {
  if (!stats) return null
  const acc = stats.accuracy != null ? `${stats.accuracy.toFixed(1)}%` : null
  return (
    <span className="text-[10px] text-muted-foreground normal-case font-normal">
      {stats.correct != null && stats.total != null && `${stats.correct}/${stats.total}`}
      {acc && ` · ${acc}`}
    </span>
  )
}

function TaskRow({
  task,
  isSel,
  onSelect,
}: {
  task: RunInfo
  isSel: boolean
  onSelect: (run: SelectedRun) => void
}) {
  return (
    <button
      onClick={() => onSelect({ provider: task.provider, model: task.model, task: task.task_path })}
      className={cn(
        "w-full text-left pl-10 pr-3 py-1.5 text-sm border-b hover:bg-accent transition-colors flex items-center gap-2",
        isSel && "bg-accent"
      )}
    >
      <span className="flex-1 truncate" title={task.task_path}>
        {task.task_id}
      </span>
      {task.total_steps != null && (
        <span className="text-xs text-muted-foreground">{task.total_steps}st</span>
      )}
      <StatusBadge submitted={task.submitted} correct={task.correct} status={task.status} />
    </button>
  )
}

function PuzzleTypeBlock({
  pt,
  selected,
  onSelect,
  open,
  onToggle,
}: {
  pt: PuzzleTypeGroup
  selected: SelectedRun | null
  onSelect: (r: SelectedRun) => void
  open: boolean
  onToggle: () => void
}) {
  const stats = readStats(pt.summary)
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full text-left pl-6 pr-3 py-1.5 text-xs font-medium border-b hover:bg-accent flex items-center gap-1"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="flex-1 truncate" title={pt.puzzle_type}>
          {pt.puzzle_type}
        </span>
        <span className="text-[10px] text-muted-foreground">{pt.tasks.length}</span>
        <Stats stats={stats} />
      </button>
      {open &&
        pt.tasks.map((t) => {
          const isSel =
            !!selected &&
            selected.provider === t.provider &&
            selected.model === t.model &&
            selected.task === t.task_path
          return <TaskRow key={t.task_path} task={t} isSel={isSel} onSelect={onSelect} />
        })}
    </div>
  )
}

function SplitBlock({
  prefix,
  split,
  selected,
  onSelect,
  expanded,
  toggle,
}: {
  prefix: string
  split: SplitGroup
  selected: SelectedRun | null
  onSelect: (r: SelectedRun) => void
  expanded: Set<string>
  toggle: (k: string) => void
}) {
  const splitKey = `${prefix}::split::${split.split}`
  const open = expanded.has(splitKey)
  const stats = readStats(split.summary)
  const totalTasks = split.puzzle_types.reduce((n, pt) => n + pt.tasks.length, 0)
  return (
    <div>
      <button
        onClick={() => toggle(splitKey)}
        className="w-full text-left pl-3 pr-3 py-1.5 text-xs font-semibold uppercase tracking-wider border-b hover:bg-accent flex items-center gap-1"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="flex-1 truncate" title={split.split}>
          {split.split}
        </span>
        <span className="text-[10px] text-muted-foreground normal-case">{totalTasks}</span>
        <Stats stats={stats} />
      </button>
      {open &&
        split.puzzle_types.map((pt) => {
          const ptKey = `${splitKey}::pt::${pt.puzzle_type}`
          return (
            <PuzzleTypeBlock
              key={pt.puzzle_type}
              pt={pt}
              selected={selected}
              onSelect={onSelect}
              open={expanded.has(ptKey)}
              onToggle={() => toggle(ptKey)}
            />
          )
        })}
    </div>
  )
}

export function RunList({
  data,
  selected,
  onSelect,
}: {
  data: RunsResponse | null
  selected: SelectedRun | null
  onSelect: (run: SelectedRun) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const allKeys = useMemo(() => {
    if (!data) return [] as string[]
    const keys: string[] = []
    for (const p of data.providers) {
      const pk = `provider::${p.provider}`
      keys.push(pk)
      for (const m of p.models) {
        const mk = `${pk}::model::${m.model}`
        keys.push(mk)
        for (const sp of m.splits) {
          const sk = `${mk}::split::${sp.split}`
          keys.push(sk)
          for (const pt of sp.puzzle_types) {
            keys.push(`${sk}::pt::${pt.puzzle_type}`)
          }
        }
      }
    }
    return keys
  }, [data])

  // Auto-expand the path that leads to the currently-selected task so it stays
  // visible across reloads / refreshes.
  useEffect(() => {
    if (!data || !selected) return
    setExpanded((prev) => {
      const next = new Set(prev)
      next.add(`provider::${selected.provider}`)
      next.add(`provider::${selected.provider}::model::${selected.model}`)
      for (const p of data.providers) {
        if (p.provider !== selected.provider) continue
        for (const m of p.models) {
          if (m.model !== selected.model) continue
          for (const sp of m.splits) {
            for (const pt of sp.puzzle_types) {
              if (pt.tasks.some((t) => t.task_path === selected.task)) {
                const pk = `provider::${selected.provider}`
                const mk = `${pk}::model::${selected.model}`
                const sk = `${mk}::split::${sp.split}`
                next.add(sk)
                next.add(`${sk}::pt::${pt.puzzle_type}`)
              }
            }
          }
        }
      }
      return next
    })
  }, [data, selected])

  if (!data) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>
  if (data.providers.length === 0)
    return <div className="p-4 text-sm text-muted-foreground">No runs found.</div>

  return (
    <div className="space-y-1">
      <div className="px-3 py-1 flex gap-3 text-[10px] uppercase tracking-wider text-muted-foreground border-b">
        <button
          onClick={() => setExpanded(new Set(allKeys))}
          className="hover:text-foreground"
        >
          Expand all
        </button>
        <button onClick={() => setExpanded(new Set())} className="hover:text-foreground">
          Collapse all
        </button>
      </div>
      {data.providers.map((p) => {
        const pk = `provider::${p.provider}`
        const providerOpen = expanded.has(pk)
        return (
          <div key={p.provider}>
            <button
              onClick={() => toggle(pk)}
              className="w-full text-left px-3 py-2 text-xs font-bold uppercase tracking-wider bg-muted/50 border-b hover:bg-accent flex items-center gap-1"
            >
              {providerOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="flex-1 truncate" title={p.provider}>{p.provider}</span>
              <span className="text-[10px] text-muted-foreground normal-case">
                {p.models.length} model{p.models.length === 1 ? "" : "s"}
              </span>
            </button>
            {providerOpen &&
              p.models.map((m) => {
                const mk = `${pk}::model::${m.model}`
                const modelOpen = expanded.has(mk)
                const stats = readStats(m.summary)
                return (
                  <div key={m.model}>
                    <button
                      onClick={() => toggle(mk)}
                      className="w-full text-left pl-1.5 pr-3 py-1.5 text-xs font-semibold border-b hover:bg-accent flex items-center gap-1"
                    >
                      {modelOpen ? (
                        <ChevronDown size={13} />
                      ) : (
                        <ChevronRight size={13} />
                      )}
                      <span className="flex-1 truncate" title={m.model}>
                        {m.model}
                      </span>
                      <Stats stats={stats} />
                    </button>
                    {modelOpen &&
                      m.splits.map((sp) => (
                        <SplitBlock
                          key={sp.split}
                          prefix={mk}
                          split={sp}
                          selected={selected}
                          onSelect={onSelect}
                          expanded={expanded}
                          toggle={toggle}
                        />
                      ))}
                  </div>
                )
              })}
          </div>
        )
      })}
    </div>
  )
}
