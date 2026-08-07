import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import { promises as fs, createReadStream, existsSync, statSync } from "node:fs"
import path from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"

// Pipe a single file to the response, with error handling. Crucially, we must
// guard against `file` being a directory: `createReadStream(<dir>)` succeeds
// synchronously but then emits an unhandled `EISDIR` error event, which
// previously killed the whole Vite dev process. We also attach `.on('error')`
// so any I/O failure mid-stream becomes a normal 500 instead of a process exit.
function pipeFile(res: ServerResponse, file: string, contentType: string, cacheControl: string) {
  let st
  try {
    st = statSync(file)
  } catch {
    return send(res, 404, { error: "not found" })
  }
  if (!st.isFile()) return send(res, 404, { error: "not a file" })
  res.statusCode = 200
  res.setHeader("Content-Type", contentType)
  res.setHeader("Cache-Control", cacheControl)
  const stream = createReadStream(file)
  stream.on("error", (err) => {
    if (!res.headersSent) {
      send(res, 500, { error: String(err) })
    } else {
      res.destroy(err)
    }
  })
  stream.pipe(res)
}

const DATA_ROOT = process.env.CAPTCHA_DATA_ROOT || path.resolve(__dirname, "../data")
const RUNS_ROOT = process.env.CAPTCHA_RUNS_ROOT || path.resolve(__dirname, "../data/Output")

// Top-level entries under DATA_ROOT that are raw dataset splits, surfaced via /api/dataset.
const DATASET_SPLITS = new Set(
  (process.env.CAPTCHA_DATASET_SPLITS || "Train,Val,Validation,Test,Datagen")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
)

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json") {
  res.statusCode = status
  res.setHeader("Content-Type", contentType)
  res.setHeader("Cache-Control", "no-store")
  res.end(typeof body === "string" || body instanceof Buffer ? body : JSON.stringify(body))
}

async function safeReadJson<T>(file: string): Promise<T | null> {
  try {
    const txt = await fs.readFile(file, "utf-8")
    return JSON.parse(txt) as T
  } catch {
    return null
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const out: string[] = []
    for (const e of entries) {
      if (e.isDirectory()) {
        out.push(e.name)
      } else if (e.isSymbolicLink()) {
        // Datasets under data/ are NAS symlinks; `isDirectory()` is false for
        // those, so resolve the link and keep it if it points at a directory.
        try {
          const s = await fs.stat(path.join(dir, e.name))
          if (s.isDirectory()) out.push(e.name)
        } catch {
          /* dangling symlink — skip */
        }
      }
    }
    return out
  } catch {
    return []
  }
}

async function statMtime(p: string): Promise<number> {
  try {
    const s = await fs.stat(p)
    return s.mtimeMs
  } catch {
    return 0
  }
}

// A task dir is identified by containing a `trajectory.jsonl`. We walk up to
// MAX_TASK_DEPTH levels under <provider>/<model>/ and bucket by depth:
//   1 part  → split="default",  puzzle_type = summary.puzzle_type or "All"
//   2 parts → split="default",  puzzle_type = parts[0]
//   3 parts → split = parts[0], puzzle_type = parts[1], task = parts[2]
//   4 parts → split = parts[0], puzzle_type = parts[1], task = parts[2]/parts[3]
//             (multi-rollout runs: <split>/<pt>/<puzzle>/rollout_N/)
const MAX_TASK_DEPTH = 4

// Concurrency-limited map. The Output tree lives on NFS (NAS symlinks), so each
// stat/readdir/read is a network round-trip — running them sequentially over
// 50k+ tasks costs ~50s. Latency-bound work parallelizes almost linearly, so a
// pool of ~48 turns that into a couple of seconds.
async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency = 48
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  return out
}

async function isTaskDir(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, "trajectory.jsonl"))
    return true
  } catch {
    return false
  }
}

async function walkModelTasks(modelDir: string): Promise<Array<{ relParts: string[] }>> {
  const out: Array<{ relParts: string[] }> = []
  async function rec(dir: string, parts: string[], depth: number) {
    if (depth > MAX_TASK_DEPTH) return
    if (parts.length > 0 && (await isTaskDir(dir))) {
      out.push({ relParts: parts })
      return
    }
    const subs = await listDirs(dir)
    // Recurse into subdirs concurrently — each level is NFS round-trips.
    await Promise.all(subs.map((s) => rec(path.join(dir, s), [...parts, s], depth + 1)))
  }
  await rec(modelDir, [], 0)
  return out
}

// `/api/runs` walks 10k+ task dirs (stat + read summary.json each), costing
// ~2-3s. The Runs tab polls every 5s, so without caching the dev server is
// permanently busy scanning. Cache the built index with a short TTL — new runs
// still surface within RUNS_CACHE_TTL_MS.
const RUNS_CACHE_TTL_MS = 60000
let _runsCache: { at: number; data: unknown } | null = null
// Single-flight: the Runs tab polls every 5s. Without this guard, a poll that
// lands while a rebuild is in progress kicks off a *second* concurrent rebuild,
// and they pile up — each hammering NFS and slowing the others down. Share one
// in-flight build instead.
let _runsInflight: Promise<unknown> | null = null

async function buildRunsIndexCached() {
  const now = Date.now()
  if (_runsCache && now - _runsCache.at < RUNS_CACHE_TTL_MS) {
    return _runsCache.data
  }
  if (_runsInflight) return _runsInflight
  _runsInflight = (async () => {
    try {
      const data = await buildRunsIndex()
      _runsCache = { at: Date.now(), data }
      return data
    } finally {
      _runsInflight = null
    }
  })()
  return _runsInflight
}

async function buildRunsIndex() {
  type TaskRec = {
    provider: string
    model: string
    task_id: string
    task_path: string
    puzzle_type?: string
    submitted?: boolean
    correct?: boolean
    reward?: number
    status?: string
    total_steps?: number
    mtime: number
  }

  const providers = await listDirs(RUNS_ROOT)
  const result = []
  for (const provider of providers) {
    const providerDir = path.join(RUNS_ROOT, provider)
    const models = await listDirs(providerDir)
    const modelEntries = []
    for (const model of models) {
      const modelDir = path.join(providerDir, model)
      const summary = await safeReadJson<unknown>(path.join(modelDir, "run_summary.json"))
      const taskRefs = await walkModelTasks(modelDir)

      // Read every task's summary.json concurrently — this is the bulk of the
      // NFS I/O. We no longer stat trajectory/dir mtimes: tasks sort by name and
      // nothing in the response or UI uses mtime, so those stats were pure waste.
      const recs = await pMap(taskRefs, async ({ relParts }) => {
        const taskDir = path.join(modelDir, ...relParts)
        // For split-nested runs the display label is everything past
        // <split>/<puzzle_type>. That is just the puzzle for 3-level runs
        // (parts[2]) and puzzle/rollout for multi-rollout runs (parts[2]/parts[3]).
        const leaf =
          relParts.length >= 3 ? relParts.slice(2).join("/") : relParts[relParts.length - 1]
        const taskSummary = await safeReadJson<{
          puzzle_type?: string
          submitted?: boolean
          correct?: boolean
          reward?: number
          status?: string
          total_steps?: number
        }>(path.join(taskDir, "summary.json"))

        let split = "default"
        let puzzleType = taskSummary?.puzzle_type || "All"
        if (relParts.length === 2) {
          puzzleType = relParts[0]
        } else if (relParts.length >= 3) {
          split = relParts[0]
          puzzleType = relParts[1]
        }

        const rec: TaskRec = {
          provider,
          model,
          task_id: leaf,
          task_path: relParts.join("/"),
          puzzle_type: taskSummary?.puzzle_type ?? puzzleType,
          submitted: taskSummary?.submitted,
          correct: taskSummary?.correct,
          reward: taskSummary?.reward,
          status: taskSummary?.status,
          total_steps: taskSummary?.total_steps,
          mtime: 0,
        }
        return { split, puzzleType, rec }
      })

      // Group: split → puzzle_type → tasks (in-memory, cheap)
      const grouped = new Map<string, Map<string, TaskRec[]>>()
      for (const { split, puzzleType, rec } of recs) {
        let byType = grouped.get(split)
        if (!byType) {
          byType = new Map<string, TaskRec[]>()
          grouped.set(split, byType)
        }
        let bucket = byType.get(puzzleType)
        if (!bucket) {
          bucket = []
          byType.set(puzzleType, bucket)
        }
        bucket.push(rec)
      }

      const splits = []
      for (const [splitName, byType] of grouped) {
        const splitDir =
          splitName === "default" ? modelDir : path.join(modelDir, splitName)
        const splitSummary = await safeReadJson<unknown>(
          path.join(splitDir, "run_summary.json")
        )
        const puzzleTypes = []
        for (const [ptName, tasks] of byType) {
          // Natural name order (numeric-aware) so multi-rollout runs list as
          // puzzle1/rollout_1..5, puzzle2/..., and images2 sorts before images10.
          tasks.sort((a, b) =>
            a.task_id.localeCompare(b.task_id, undefined, { numeric: true })
          )
          const ptDir =
            splitName === "default"
              ? path.join(modelDir, ptName)
              : path.join(modelDir, splitName, ptName)
          const ptSummary = await safeReadJson<unknown>(
            path.join(ptDir, "run_summary.json")
          )
          puzzleTypes.push({ puzzle_type: ptName, summary: ptSummary, tasks })
        }
        puzzleTypes.sort((a, b) => a.puzzle_type.localeCompare(b.puzzle_type))
        splits.push({ split: splitName, summary: splitSummary, puzzle_types: puzzleTypes })
      }
      splits.sort((a, b) => {
        if (a.split === "default") return -1
        if (b.split === "default") return 1
        return a.split.localeCompare(b.split)
      })
      modelEntries.push({ model, summary, splits })
    }
    result.push({ provider, models: modelEntries })
  }
  return { providers: result }
}

async function readTrajectory(provider: string, model: string, task: string) {
  const file = path.join(RUNS_ROOT, provider, model, task, "trajectory.jsonl")
  try {
    const txt = await fs.readFile(file, "utf-8")
    return txt
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function getQuery(url: string) {
  const u = new URL(url, "http://localhost")
  return Object.fromEntries(u.searchParams)
}

function safeJoin(root: string, ...parts: string[]) {
  const base = path.resolve(root)
  const resolved = path.resolve(base, ...parts)
  if (!resolved.startsWith(base)) return null
  return resolved
}

async function buildDatasetIndex() {
  const splits = (await listDirs(DATA_ROOT)).filter((s) => DATASET_SPLITS.has(s))
  const result = []
  for (const split of splits) {
    const splitDir = path.join(DATA_ROOT, split)
    const types = await listDirs(splitDir)
    const typeEntries = []
    for (const type of types) {
      const typeDir = path.join(splitDir, type)
      const gt = await safeReadJson<Record<string, { prompt?: string }>>(
        path.join(typeDir, "ground_truth.json")
      )
      let count = 0
      let samplePrompt: string | null = null
      if (gt && typeof gt === "object") {
        const ids = Object.keys(gt)
        count = ids.length
        for (const id of ids) {
          if (gt[id]?.prompt) {
            samplePrompt = gt[id].prompt!
            break
          }
        }
      }
      typeEntries.push({ type, count, prompt: samplePrompt })
    }
    typeEntries.sort((a, b) => a.type.localeCompare(b.type))
    result.push({ split, types: typeEntries })
  }
  result.sort((a, b) => a.split.localeCompare(b.split))
  return { splits: result }
}

// data/.thumbs/dims.json — rel path → [origW, origH], written by
// scripts/gen_dataset_thumbs.py. Cached by mtime; null when absent.
let _dimsCache: { mtime: number; data: Record<string, [number, number]> } | null = null

async function loadThumbDims(): Promise<Record<string, [number, number]> | null> {
  const file = path.join(DATA_ROOT, ".thumbs", "dims.json")
  let st
  try {
    st = await fs.stat(file)
  } catch {
    return null
  }
  if (!_dimsCache || _dimsCache.mtime !== st.mtimeMs) {
    const data = await safeReadJson<Record<string, [number, number]>>(file)
    if (!data) return null
    _dimsCache = { mtime: st.mtimeMs, data }
  }
  return _dimsCache.data
}

async function readDatasetItems(split: string, type: string) {
  if (!DATASET_SPLITS.has(split)) return null
  const typeDir = path.join(DATA_ROOT, split, type)
  const gt = await safeReadJson<Record<string, Record<string, unknown>>>(
    path.join(typeDir, "ground_truth.json")
  )
  if (!gt || typeof gt !== "object") return []
  // Computer-use answer format (answer_cu / answer_cu_kind) — merged when present.
  const gtCu = await safeReadJson<Record<string, Record<string, unknown>>>(
    path.join(typeDir, "ground_truth_cu.json")
  )
  const dims = await loadThumbDims()

  const out = []
  for (const [id, entry] of Object.entries(gt)) {
    const cu = gtCu?.[id] || {}
    // Some types use a directory as the entry key (e.g. Image_Recognition/images1)
    // — point image_url at the composite grid.png inside the folder.
    // Determine the image to show for this entry.  Most puzzle types use the
    // GT key itself as the image filename (e.g. "bingo1.png").  Some types use
    // a non-image key (e.g. "puzzle1.json" for Connect_icon) and store the
    // actual image path in a `reference_image` field instead.
    let imgRel = id
    const idPath = path.join(typeDir, id)
    let imgFile = idPath
    const entryObj = entry as Record<string, unknown>

    // 1. If the key doesn't point at an existing image file, fall back to
    //    reference_image / order_image / image fields from the GT entry.
    if (!existsSync(idPath) || id.endsWith(".json")) {
      const fallbacks = ["reference_image", "order_image", "image"]
      for (const fb of fallbacks) {
        const val = entryObj[fb]
        if (typeof val === "string" && existsSync(path.join(typeDir, val))) {
          imgRel = val
          imgFile = path.join(typeDir, val)
          break
        }
      }
    }

    try {
      const st = await fs.stat(imgFile)
      if (st.isDirectory()) {
        const candidates = ["grid.png", "composite.png", "image.png", "1.png"]
        for (const c of candidates) {
          if (existsSync(path.join(imgFile, c))) {
            imgRel = `${imgRel}/${c}`
            imgFile = path.join(imgFile, c)
            break
          }
        }
      }
    } catch {
      // missing — leave imgRel as-is, the image route will 404 cleanly
    }
    // Append the source-file mtime as a cache-buster so regenerated images
    // refresh in the browser without forcing a page reload, while unchanged
    // images stay cached normally.
    const v = await statMtime(imgFile)
    const dim = dims?.[`${split}/${type}/${imgRel}`] ?? null

    out.push({
      id,
      image_url: `/dataset_image/${encodeURIComponent(split)}/${encodeURIComponent(type)}/${imgRel
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?v=${Math.floor(v)}`,
      // Original pixel size (from .thumbs/dims.json) — lets the client render
      // the thumb while scaling trajectory-dot coords in the original frame.
      natural_w: dim?.[0] ?? null,
      natural_h: dim?.[1] ?? null,
      prompt: (entry as { prompt?: string })?.prompt ?? null,
      description: (entry as { description?: string })?.description ?? null,
      answer: (entry as { answer?: unknown })?.answer ?? null,
      answer_cu: (cu as { answer_cu?: unknown })?.answer_cu ?? null,
      answer_cu_kind: (cu as { answer_cu_kind?: string })?.answer_cu_kind ?? null,
      // Optional spatial-viz sibling: image-natural per-alt click coords for
      // puzzles whose answer_cu uses viewport coords (rendered as dots on the
      // static puzzle image in the dataset card).
      viz_natural_xy: (cu as { viz_natural_xy?: unknown })?.viz_natural_xy ?? null,
      // Grid puzzles (Bingo) carry [rows, cols]; lets the client place swap-cell
      // dots from the layout-independent `answer` indices on the static image.
      grid_size: (entry as { grid_size?: unknown })?.grid_size ?? null,
      extra: entry,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// SFT review — browse ms-swift chat JSONL records (multi-turn messages with
// screenshots) straight off the NAS.
// ---------------------------------------------------------------------------
const SFT_ROOT =
  process.env.CAPTCHA_SFT_ROOT || "/mount/NAS1/public/zhangzhenhao/Captcha/data/SFT_data"
const SFT_SPLITS = ["train", "val", "smoke"]
// Image paths inside the JSONL carry the training-cluster mount prefix; this
// box sees the same NAS under /mount/NAS1.
const SFT_IMG_CLUSTER_PREFIX = "/run/determined/NAS1"
const SFT_IMG_LOCAL_PREFIX = "/mount/NAS1"
const SFT_IMG_ALLOWED_ROOT = "/mount/NAS1/public/zhangzhenhao"

// Listing counts lines across every JSONL (3–18 MB each), so cache it.
// Per-file line-count cache keyed by path → {mtime,size,count}. listSftFiles
// used to re-read EVERY jsonl (incl. the 41MB perturn files) on each call once
// its old 60s blanket cache expired — ~7s over NFS, which felt like the SFT
// dropdown hanging every time you came back after a minute. Now we stat every
// file (cheap) and only re-read the ones whose mtime/size changed, so only the
// first-ever call (or a genuinely changed file) pays the read cost.
const _sftCountCache = new Map<string, { mtime: number; size: number; count: number }>()

async function listSftFiles() {
  const splits = []
  for (const split of SFT_SPLITS) {
    const dir = path.join(SFT_ROOT, split)
    let names: string[] = []
    try {
      // Accept both .jsonl and .json (some packed-thinking dumps were saved as
      // .json, e.g. bingo_sft_*_new_thinking.json — they're JSONL content). The
      // record reader splits on newlines regardless of extension.
      names = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl") || n.endsWith(".json"))
    } catch {
      continue
    }
    const files = []
    for (const name of names.sort()) {
      const fp = path.join(dir, name)
      try {
        const st = await fs.stat(fp)
        const hit = _sftCountCache.get(fp)
        let count: number
        if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) {
          count = hit.count
        } else {
          const txt = await fs.readFile(fp, "utf-8")
          count = txt.split("\n").filter((l) => l.trim()).length
          _sftCountCache.set(fp, { mtime: st.mtimeMs, size: st.size, count })
        }
        files.push({ name, rel: `${split}/${name}`, count })
      } catch {
        // unreadable / stat failed — skip
      }
    }
    splits.push({ split, files })
  }
  return { sft_root: SFT_ROOT, splits }
}

// Cache the split lines of the most-recently-browsed file so next/prev clicks
// don't re-read 18 MB from the NAS per record.
let _sftLinesCache: { file: string; mtime: number; lines: string[] } | null = null

function rewriteSftImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteSftImages)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, rewriteSftImages(v)])
    )
  }
  if (
    typeof value === "string" &&
    /\.(png|jpe?g|webp|gif)$/i.test(value) &&
    (value.startsWith(SFT_IMG_CLUSTER_PREFIX + "/") || value.startsWith(SFT_IMG_LOCAL_PREFIX + "/"))
  ) {
    // Append an mtime cache-buster: /sft_image is served `immutable` for 24h,
    // so without ?v=<mtime> a REGENERATED screenshot at the same path keeps
    // showing the stale old image in the browser (this is exactly what made a
    // re-mocked dart_count puzzle look "wrong"). Mirrors the dataset images.
    const local = value.startsWith(SFT_IMG_CLUSTER_PREFIX + "/")
      ? SFT_IMG_LOCAL_PREFIX + value.slice(SFT_IMG_CLUSTER_PREFIX.length)
      : value
    let v = ""
    try {
      v = `&v=${Math.round(statSync(local).mtimeMs)}`
    } catch {
      // file missing / NAS hiccup — fall back to no buster
    }
    return `/sft_image/?p=${encodeURIComponent(value)}${v}`
  }
  return value
}

async function readSftRecord(rel: string, index: number) {
  const file = safeJoin(SFT_ROOT, ...rel.split("/"))
  if (!file || !(file.endsWith(".jsonl") || file.endsWith(".json"))) return { error: "bad file" }
  let st
  try {
    st = await fs.stat(file)
  } catch {
    return { error: "file not found" }
  }
  if (!_sftLinesCache || _sftLinesCache.file !== file || _sftLinesCache.mtime !== st.mtimeMs) {
    const txt = await fs.readFile(file, "utf-8")
    _sftLinesCache = { file, mtime: st.mtimeMs, lines: txt.split("\n").filter((l) => l.trim()) }
  }
  const lines = _sftLinesCache.lines
  if (!(index >= 0 && index < lines.length))
    return { error: `index out of range (0..${lines.length - 1})`, count: lines.length }
  try {
    const rec = JSON.parse(lines[index])
    return {
      index,
      count: lines.length,
      record: rewriteSftImages(rec),
      result_image: await computeResultImage(rec),
    }
  } catch {
    return { error: `bad json at line ${index}`, count: lines.length }
  }
}

// The post-submit "result" screenshot. A trajectory's screenshots are
// step_0..step_(N-1) — the states the model sees before each of its N actions.
// step_N is the page AFTER the final submit (e.g. the "Correct!" banner). It is
// deliberately NOT in the training JSONL (training stops at submit), but it's
// useful to eyeball in the review viewer. Find the last referenced
// screenshot_step_<n>.png and, if step_<n+1>.png exists on disk, return its URL.
async function computeResultImage(rec: unknown): Promise<string | null> {
  const msgs = (rec as { messages?: unknown })?.messages
  if (!Array.isArray(msgs)) return null
  let last: string | null = null
  for (const m of msgs) {
    const content = (m as { content?: unknown }).content
    if (Array.isArray(content)) {
      for (const p of content) {
        const part = p as { type?: string; image?: unknown }
        if (part.type === "image" && typeof part.image === "string") last = part.image
      }
    }
  }
  if (!last) return null
  const mm = last.match(/^(.*screenshot_step_)(\d+)(\.png)$/)
  if (!mm) return null
  const nextIdx = parseInt(mm[2], 10) + 1
  // A path-exists check honoring the cluster→local mapping and allowed root.
  const fileExists = async (orig: string): Promise<boolean> => {
    const local = orig.startsWith(SFT_IMG_CLUSTER_PREFIX + "/")
      ? SFT_IMG_LOCAL_PREFIX + orig.slice(SFT_IMG_CLUSTER_PREFIX.length)
      : orig
    const resolved = path.resolve(local)
    if (!resolved.startsWith(SFT_IMG_ALLOWED_ROOT + "/")) return false
    try {
      return (await fs.stat(resolved)).isFile()
    } catch {
      return false
    }
  }
  const nextOrig = `${mm[1]}${nextIdx}${mm[3]}`
  // Only surface step_(N+1) when it's the LAST screenshot in the folder — i.e. the
  // real post-submit result. For per-turn records that stop mid-trajectory,
  // step_(N+1) is just the next intermediate frame (step_(N+2) exists) — skip it.
  if (!(await fileExists(nextOrig))) return null
  if (await fileExists(`${mm[1]}${nextIdx + 1}${mm[3]}`)) return null
  // Same mtime cache-buster as rewriteSftImages so a regenerated result frame
  // doesn't get served stale from the browser's immutable cache.
  const nextLocal = nextOrig.startsWith(SFT_IMG_CLUSTER_PREFIX + "/")
    ? SFT_IMG_LOCAL_PREFIX + nextOrig.slice(SFT_IMG_CLUSTER_PREFIX.length)
    : nextOrig
  let v = ""
  try {
    v = `&v=${Math.round(statSync(nextLocal).mtimeMs)}`
  } catch {
    // ignore — fall back to no buster
  }
  return `/sft_image/?p=${encodeURIComponent(nextOrig)}${v}`
}

function captchaApiPlugin(): Plugin {
  // Shared API + image middleware, registered on BOTH the dev server and the
  // preview server. This lets a production build (`vite build` + `vite preview`)
  // keep the /api, /sft_image, /dataset_image, /screenshots routes — which
  // previously only ran in dev. The bundled build loads far faster than dev's
  // unbundled module waterfall, which matters a lot for remote viewers on a
  // slow/high-latency SSH tunnel.
  const apiMiddleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url || ""
        try {
          if (url.startsWith("/api/runs")) {
            const data = await buildRunsIndexCached()
            return send(res, 200, data)
          }
          if (url.startsWith("/api/trajectory")) {
            const q = getQuery(url)
            if (!q.provider || !q.model || !q.task) return send(res, 400, { error: "missing params" })
            const data = await readTrajectory(q.provider, q.model, q.task)
            return send(res, 200, data)
          }
          if (url.startsWith("/api/meta")) {
            const q = getQuery(url)
            if (!q.provider || !q.model || !q.task) return send(res, 400, { error: "missing params" })
            const file = safeJoin(RUNS_ROOT, q.provider, q.model, q.task, "metafile.json")
            if (!file) return send(res, 400, { error: "bad path" })
            const data = await safeReadJson(file)
            return send(res, 200, data)
          }
          if (url.startsWith("/api/sft/files")) {
            return send(res, 200, await listSftFiles())
          }
          if (url.startsWith("/api/sft/record")) {
            const q = getQuery(url)
            if (!q.file || q.index == null) return send(res, 400, { error: "missing params" })
            return send(res, 200, await readSftRecord(q.file, parseInt(q.index, 10)))
          }
          if (url.startsWith("/sft_image/")) {
            const q = getQuery(url)
            const orig = q.p || ""
            const local = orig.startsWith(SFT_IMG_CLUSTER_PREFIX + "/")
              ? SFT_IMG_LOCAL_PREFIX + orig.slice(SFT_IMG_CLUSTER_PREFIX.length)
              : orig
            const resolved = path.resolve(local)
            if (!resolved.startsWith(SFT_IMG_ALLOWED_ROOT + "/"))
              return send(res, 400, { error: "path not allowed" })
            const ext = path.extname(resolved).toLowerCase()
            const ct =
              ext === ".jpg" || ext === ".jpeg"
                ? "image/jpeg"
                : ext === ".webp"
                  ? "image/webp"
                  : ext === ".gif"
                    ? "image/gif"
                    : "image/png"
            pipeFile(res, resolved, ct, "public, max-age=86400, immutable")
            return
          }
          if (url.startsWith("/api/dataset/items")) {
            const q = getQuery(url)
            if (!q.split || !q.type) return send(res, 400, { error: "missing params" })
            const data = await readDatasetItems(q.split, q.type)
            if (data === null) return send(res, 400, { error: "not a dataset split" })
            return send(res, 200, data)
          }
          if (url.startsWith("/api/dataset")) {
            const data = await buildDatasetIndex()
            return send(res, 200, data)
          }
          if (url.startsWith("/dataset_image/")) {
            const rel = decodeURIComponent(url.replace(/^\/dataset_image\//, "").split("?")[0])
            const segments = rel.split("/")
            if (segments.length < 3) return send(res, 400, { error: "bad path" })
            const [split, type, ...rest] = segments
            if (!DATASET_SPLITS.has(split)) return send(res, 400, { error: "not a dataset split" })
            const file = safeJoin(DATA_ROOT, split, type, ...rest)
            if (!file) return send(res, 404, { error: "not found" })

            // ?thumb=1 → serve the pre-generated WebP from data/.thumbs/ (see
            // scripts/gen_dataset_thumbs.py). Fall back to the original when
            // the thumb is missing or older than its source, so a forgotten
            // regen only costs bandwidth, never shows a stale image.
            const wantThumb = getQuery(url).thumb === "1"
            if (wantThumb) {
              const thumb = safeJoin(DATA_ROOT, ".thumbs", split, type, ...rest)
              const thumbFile = thumb ? `${thumb}.webp` : null
              if (thumbFile && existsSync(thumbFile)) {
                try {
                  if (statSync(thumbFile).mtimeMs >= statSync(file).mtimeMs) {
                    pipeFile(res, thumbFile, "image/webp", "public, max-age=31536000, immutable")
                    return
                  }
                } catch {
                  // stat race — fall through to the original
                }
              }
            }

            const ext = path.extname(file).toLowerCase()
            const ct =
              ext === ".jpg" || ext === ".jpeg"
                ? "image/jpeg"
                : ext === ".webp"
                  ? "image/webp"
                  : ext === ".gif"
                    ? "image/gif"
                    : "image/png"
            // The /dataset_image URL already includes a ?v=<mtime> cache buster,
            // so the browser can keep these forever — when the file changes the
            // URL changes, and the cache miss happens naturally.
            pipeFile(res, file, ct, "public, max-age=31536000, immutable")
            return
          }
          if (url.startsWith("/screenshots/")) {
            // Split BEFORE decode so the task path (encoded with %2F as a single
            // segment) survives intact — nested tasks like
            // "test/bingo_500/Bingo_500_bingo660" are passed as one encoded
            // segment, not three.
            const raw = url.replace(/^\/screenshots\//, "").split("?")[0]
            const segments = raw.split("/").map(decodeURIComponent)
            if (segments.length < 4) return send(res, 400, { error: "bad path" })
            const [provider, model, task, ...rest] = segments
            const file = safeJoin(RUNS_ROOT, provider, model, task, "screenshots", ...rest)
            if (!file) return send(res, 404, { error: "not found" })
            pipeFile(res, file, "image/png", "no-store")
            return
          }
        } catch (e) {
          return send(res, 500, { error: String(e) })
        }
        next()
  }
  return {
    name: "captcha-api",
    configureServer(server) {
      server.middlewares.use(apiMiddleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(apiMiddleware)
    },
  }
}

export default defineConfig({
  plugins: [react(), captchaApiPlugin()],
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
})
