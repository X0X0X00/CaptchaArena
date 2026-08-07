import { useCallback, useEffect, useState } from "react"
import { fetchSftFiles, fetchSftRecord } from "../api"
import type { SftFilesIndex, SftMessage, SftRecordResponse, SftToolCall } from "../types"
import { ScrollArea } from "./ui/scroll-area"
import { Badge } from "./ui/badge"
import { ChevronLeft, ChevronRight } from "lucide-react"

/** Split an assistant content string into its <think> body and the remainder. */
function splitThink(text: string): { think: string | null; rest: string } {
  const m = text.match(/<think>([\s\S]*?)<\/think>/)
  if (!m) return { think: null, rest: text }
  return { think: m[1].trim(), rest: text.replace(m[0], "").trim() }
}

function ToolCallBlock({ tc }: { tc: SftToolCall }) {
  let args = tc.function.arguments
  try {
    args = JSON.stringify(JSON.parse(tc.function.arguments))
  } catch {
    // keep raw string
  }
  return (
    <code className="block bg-zinc-900 text-emerald-300 rounded px-2 py-1 text-xs font-mono">
      {tc.function.name}({args})
    </code>
  )
}

const ROLE_STYLES: Record<string, { box: string; label: string }> = {
  system: { box: "bg-muted/60 border-muted-foreground/20", label: "text-muted-foreground" },
  user: { box: "bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-900", label: "text-blue-600" },
  assistant: {
    box: "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900",
    label: "text-emerald-600",
  },
  tool: {
    box: "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900",
    label: "text-amber-600",
  },
}

function MessageCard({
  msg,
  onOpenImage,
}: {
  msg: SftMessage
  onOpenImage: (src: string) => void
}) {
  const style = ROLE_STYLES[msg.role] ?? ROLE_STYLES.system

  if (msg.role === "system") {
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
    return (
      <details className={`border rounded-md px-3 py-2 ${style.box}`}>
        <summary className={`text-xs font-semibold uppercase cursor-pointer ${style.label}`}>
          system <span className="normal-case font-normal">({text.length} chars — click to expand)</span>
        </summary>
        <pre className="mt-2 text-xs whitespace-pre-wrap break-words">{text}</pre>
      </details>
    )
  }

  return (
    <div className={`border rounded-md px-3 py-2 ${style.box}`}>
      <div className={`text-xs font-semibold uppercase mb-1 ${style.label}`}>
        {msg.role}
        {msg.tool_call_id && (
          <span className="normal-case font-normal text-muted-foreground"> · {msg.tool_call_id}</span>
        )}
      </div>

      {typeof msg.content === "string" ? (
        msg.role === "assistant" ? (
          <AssistantText text={msg.content} />
        ) : (
          <div className="text-sm whitespace-pre-wrap break-words">{msg.content}</div>
        )
      ) : (
        <div className="space-y-2">
          {msg.content.map((part, i) =>
            part.type === "image" && part.image ? (
              <img
                key={i}
                src={part.image}
                loading="lazy"
                className="max-w-[480px] rounded border cursor-zoom-in"
                onClick={() => onOpenImage(part.image!)}
                alt="sft screenshot"
              />
            ) : (
              <div key={i} className="text-sm whitespace-pre-wrap break-words">
                {part.text ?? JSON.stringify(part)}
              </div>
            )
          )}
        </div>
      )}

      {msg.tool_calls && msg.tool_calls.length > 0 && (
        <div className="mt-2 space-y-1">
          {msg.tool_calls.map((tc) => (
            <ToolCallBlock key={tc.id} tc={tc} />
          ))}
        </div>
      )}
    </div>
  )
}

function AssistantText({ text }: { text: string }) {
  const { think, rest } = splitThink(text)
  return (
    <div className="space-y-1">
      {think != null && (
        <div className="text-xs italic text-muted-foreground bg-background/60 rounded px-2 py-1 whitespace-pre-wrap break-words">
          💭 {think}
        </div>
      )}
      {rest && <div className="text-sm whitespace-pre-wrap break-words">{rest}</div>}
    </div>
  )
}

export function SftView({ onOpenImage }: { onOpenImage: (src: string) => void }) {
  const [files, setFiles] = useState<SftFilesIndex | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>("") // rel path
  const [index, setIndex] = useState(0)
  const [resp, setResp] = useState<SftRecordResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [jump, setJump] = useState("")

  useEffect(() => {
    fetchSftFiles()
      .then(setFiles)
      .catch((e) => setFilesError(String(e)))
  }, [])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setLoading(true)
    fetchSftRecord(selected, index)
      .then((r) => {
        if (!cancelled) setResp(r)
      })
      .catch((e) => {
        if (!cancelled) setResp({ error: String(e) })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected, index])

  const count = resp?.count ?? 0
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), [])
  const next = useCallback(
    () => setIndex((i) => (count ? Math.min(count - 1, i + 1) : i + 1)),
    [count]
  )

  // ← / → keyboard paging (skip when typing in the jump box).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return
      if (e.key === "ArrowLeft") prev()
      if (e.key === "ArrowRight") next()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [prev, next])

  if (filesError)
    return <div className="p-6 text-sm text-destructive">SFT index failed: {filesError}</div>
  if (!files) return <div className="p-6 text-sm text-muted-foreground">Loading SFT index…</div>

  const allFiles = files.splits.flatMap((s) => s.files)
  if (allFiles.length === 0)
    return (
      <div className="p-6 text-sm text-muted-foreground">
        No .jsonl found under {files.sft_root}
      </div>
    )

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b px-4 py-2 flex items-center gap-3 flex-wrap">
        <select
          className="border rounded px-2 py-1 text-sm bg-background max-w-[420px]"
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value)
            setIndex(0)
          }}
        >
          <option value="">— select a JSONL —</option>
          {files.splits.map((s) => (
            <optgroup key={s.split} label={s.split}>
              {s.files.map((f) => (
                <option key={f.rel} value={f.rel}>
                  {f.name} ({f.count})
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        {selected && (
          <>
            <button
              onClick={prev}
              disabled={index <= 0}
              className="border rounded p-1 hover:bg-accent disabled:opacity-40"
              title="Previous (←)"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm tabular-nums">
              {index + 1} / {count || "?"}
            </span>
            <button
              onClick={next}
              disabled={count > 0 && index >= count - 1}
              className="border rounded p-1 hover:bg-accent disabled:opacity-40"
              title="Next (→)"
            >
              <ChevronRight size={16} />
            </button>
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault()
                const n = parseInt(jump, 10)
                if (!Number.isNaN(n) && n >= 1 && (!count || n <= count)) setIndex(n - 1)
              }}
            >
              <input
                value={jump}
                onChange={(e) => setJump(e.target.value)}
                placeholder="#"
                className="border rounded px-2 py-1 text-sm w-16 bg-background"
              />
              <button type="submit" className="text-xs border rounded px-2 py-1 hover:bg-accent">
                Go
              </button>
            </form>
            {loading && <Badge variant="secondary">loading…</Badge>}
            {resp?.record?.messages && (
              <Badge variant="outline">{resp.record.messages.length} msgs</Badge>
            )}
          </>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground truncate" title={files.sft_root}>
          {files.sft_root}
        </span>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 max-w-[860px] mx-auto space-y-2">
          {!selected && (
            <div className="text-sm text-muted-foreground">Pick a JSONL file above to start.</div>
          )}
          {resp?.error && <div className="text-sm text-destructive">{resp.error}</div>}
          {resp?.record?.messages.map((m, i) => (
            <MessageCard key={i} msg={m} onOpenImage={onOpenImage} />
          ))}
          {resp?.result_image && (
            <div className="border rounded-md px-3 py-2 bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900">
              <div className="text-xs font-semibold uppercase mb-1 text-emerald-600">
                ✅ result (post-submit)
                <span className="normal-case font-normal text-muted-foreground">
                  {" "}
                  — review only, not in training data
                </span>
              </div>
              <img
                src={resp.result_image}
                loading="lazy"
                className="max-w-[480px] rounded border cursor-zoom-in"
                onClick={() => onOpenImage(resp.result_image!)}
                alt="post-submit result"
              />
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
