export interface RunInfo {
  provider: string
  model: string
  task_id: string
  /** Relative path under `<provider>/<model>/` — may include slashes for
   *  nested layouts (e.g. "test/bingo_500/Bingo_500_bingo660"). Use this for
   *  API calls; use `task_id` (leaf) for display. */
  task_path: string
  puzzle_type?: string
  submitted?: boolean
  correct?: boolean
  reward?: number
  status?: string
  total_steps?: number
  mtime: number
}

export interface ModelSummary {
  benchmark: string
  agent: string
  total_puzzles: number
  total_submitted: number
  total_correct: number
  accuracy: number
  puzzles: Array<{
    task_id: string
    puzzle_type: string
    submitted: boolean
    correct: boolean
    reward: number
    status: string
  }>
}

export interface TrajectoryEvent {
  run_id: string
  event_index: number
  timestamp: string
  event_type: "run_start" | "tool_call" | string
  provider: string
  step: number | null
  action: string | null
  params: Record<string, unknown>
  result: string | null
  page_state: {
    url?: string
    title?: string
    prompt?: string
    feedback?: string | null
    feedback_class?: string
    stats?: { total: number; correct: number; accuracy: string }
    debug_info?: unknown
    puzzle?: { puzzle_type: string; puzzle_id: string; input_type: string }
  } | null
  note: string
  screenshot_path: string | null
  metadata: Record<string, unknown>
}

export interface TaskMeta {
  benchmark: string
  agent: string
  task_id: string
  summary_info: { cum_reward: number }
  goal: string
  steps: Array<{
    screenshot_path: string
    reasoning: string
    action: string
    result: string
  }>
}

export interface DatasetTypeInfo {
  type: string
  count: number
  prompt: string | null
}

export interface DatasetSplitInfo {
  split: string
  types: DatasetTypeInfo[]
}

export interface DatasetIndex {
  splits: DatasetSplitInfo[]
}

export type AnswerCuKind =
  | "single_xy"
  | "multi_xy"
  | "multi_swap"
  | "drag"
  | "option"
  | "type_text"
  | "hold"
  | "rotate"

export interface DatasetItem {
  id: string
  image_url: string
  /** Original pixel size from .thumbs/dims.json; null when no thumbs built. */
  natural_w: number | null
  natural_h: number | null
  prompt: string | null
  description: string | null
  answer: unknown
  answer_cu: unknown
  answer_cu_kind: AnswerCuKind | string | null
  /** Optional per-alt image-natural pixel coords for spatial dot rendering on
   *  the static card image when answer_cu uses viewport coords. Shape:
   *  `[ [[x,y], ...], ... ]` — outer = alternatives, inner = clicks per alt. */
  viz_natural_xy?: number[][][] | null
  /** Grid puzzles (Bingo) carry [rows, cols] so swap-cell dots can be derived
   *  from the layout-independent `answer` indices. */
  grid_size?: [number, number] | null
  extra: Record<string, unknown>
}

// ---- SFT review ----

export interface SftFileInfo {
  name: string
  /** "<split>/<name>.jsonl" — pass to /api/sft/record */
  rel: string
  count: number
}

export interface SftFilesIndex {
  sft_root: string
  splits: Array<{ split: string; files: SftFileInfo[] }>
}

export interface SftContentPart {
  type: string
  text?: string
  /** Rewritten to a /sft_image/?p=... URL by the server. */
  image?: string
}

export interface SftToolCall {
  id: string
  type: string
  function: { name: string; arguments: string }
}

export interface SftMessage {
  role: "system" | "user" | "assistant" | "tool" | string
  content: string | SftContentPart[]
  tool_calls?: SftToolCall[]
  tool_call_id?: string
}

export interface SftRecordResponse {
  index?: number
  count?: number
  record?: { messages: SftMessage[]; tools?: unknown[] }
  /** Post-submit "result" screenshot (step_N+1) for review only — not in training data. */
  result_image?: string | null
  error?: string
}

export interface PuzzleTypeGroup {
  puzzle_type: string
  summary: ModelSummary | null
  tasks: RunInfo[]
}

export interface SplitGroup {
  /** "default" for old single-level layouts, otherwise the split folder name
   *  (e.g. "test" / "validation" / "smoke"). */
  split: string
  summary: ModelSummary | null
  puzzle_types: PuzzleTypeGroup[]
}

export interface RunsResponse {
  providers: Array<{
    provider: string
    models: Array<{
      model: string
      summary: ModelSummary | null
      splits: SplitGroup[]
    }>
  }>
}
