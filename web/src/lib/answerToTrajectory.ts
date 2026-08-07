// Convert a puzzle's `answer_cu` (computer-use canonical answer, from
// ground_truth_cu.json) into a normalised list of mouse steps for the
// TrajectoryPlayer. Coordinates are image-natural pixels; the player rescales
// to display size via naturalWidth/Height.
//
// answer_cu_kind taxonomy (observed across all 20 puzzle types):
//   single_xy   [x, y]                         — one click
//   multi_xy    [[x,y], ...]                   — N clicks in order
//   multi_swap  [[[x1,y1],[x2,y2]], ...]       — pairs of clicks (e.g. Bingo swaps)
//   drag        {drag:{from?:[x,y], to:[x,y]}} — drag with optional start
//   option      {select_option_index: N}       — non-spatial: pick option N
//   type_text   {type_text: "..."}             — non-spatial: type text
//   hold        {duration_ms: N}               — non-spatial: hold a button
//   rotate      {rotate_to_angle: deg}         — non-spatial: rotate to angle
//   tool_calls  [{action,arguments}...]        — flat sequence in VIEWPORT
//                                                coords (1280×1080), including
//                                                explicit submit + optional
//                                                scroll. Multiple alts wrap
//                                                in an outer list.

export interface TrajectoryStep {
  type: "click" | "drag" | "info"
  x?: number
  y?: number
  fromX?: number
  fromY?: number
  toX?: number
  toY?: number
  label: string
  note?: string
}

export interface TrajectoryResult {
  steps: TrajectoryStep[]
  /**
   * Multiple equally-valid solutions for the same puzzle (e.g. Bingo with
   * several possible swap pairs). When set, `steps` mirrors `alternatives[0]`
   * and the player should expose an alt-switcher.
   */
  alternatives?: TrajectoryStep[][]
  /** True when the answer can be rendered as spatial markers on the image. */
  spatial: boolean
  /** Short human-readable summary of the answer (always set). */
  summary: string
  /** Echo the raw kind for badge display. */
  kind: string | null
  /**
   * True when, after the spatial steps, the agent must still click a Submit
   * button (coords not encoded in the GT — agent has to locate it).
   */
  needsSubmit?: boolean
  /**
   * Coordinate frame the `steps` are expressed in, when it is NOT the image's
   * natural pixel size. Bingo swap-cell dots use a normalised grid frame
   * (cols·U × rows·U) so they render with no dims.json. The player should
   * prefer this over the measured/natural size when present.
   */
  coordSize?: { w: number; h: number } | null
}

interface Input {
  answer_cu: unknown
  answer_cu_kind: string | null
  // Fallback only — used for kind-less rows.
  answer?: unknown
  /** Image-natural per-alt click coords (purely for dataset-card visualisation
   *  when answer_cu uses viewport coords that don't map to the static image). */
  viz_natural_xy?: number[][][] | null
  /** Grid puzzles (Bingo): [rows, cols]. Combined with `answer` (cell-index
   *  swap pairs) this places swap-cell dots on the static image — independent of
   *  both the viewport-pixel answer_cu AND the image size (cells are a uniform
   *  fraction of the image), so it needs no dims.json / natural size. */
  grid_size?: [number, number] | null
}

const isPair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number"

/** Bingo's `answer` is a list of alternative swap-pairs given as CELL INDICES
 *  (row-major, 0..rows*cols-1) — layout-independent. Each cell occupies an even
 *  1/cols × 1/rows slice of the image, so a cell centre is a FIXED fraction of
 *  the image regardless of its pixel size. We emit the two tiles-to-swap as red
 *  dots in a normalised cols·U × rows·U frame (returned as `coordSize`), which
 *  the player positions by ratio — correct on every split's thumbnail with no
 *  dims.json needed (Train/Val/Test never carried viz_natural_xy). */
function gridSwapAlternatives(
  answer: unknown,
  grid: [number, number] | null | undefined,
): { alts: TrajectoryStep[][]; coordSize: { w: number; h: number } } | null {
  if (!Array.isArray(grid) || grid.length !== 2) return null
  const [rows, cols] = grid
  if (!(rows > 0 && cols > 0)) return null
  if (!Array.isArray(answer) || answer.length === 0) return null
  const U = 100
  const centre = (idx: number): [number, number] => [
    ((idx % cols) + 0.5) * U,
    (Math.floor(idx / cols) + 0.5) * U,
  ]
  const alts: TrajectoryStep[][] = []
  for (const pair of answer as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    const [i, j] = pair
    if (typeof i !== "number" || typeof j !== "number") continue
    if (i < 0 || i >= rows * cols || j < 0 || j >= rows * cols) continue
    const [ax, ay] = centre(i)
    const [bx, by] = centre(j)
    alts.push([
      { type: "click", x: ax, y: ay, label: "1", note: "swap a" },
      { type: "click", x: bx, y: by, label: "2", note: "swap b" },
    ])
  }
  return alts.length > 0 ? { alts, coordSize: { w: cols * U, h: rows * U } } : null
}


/** Infer kind from answer_cu structure when the GT omits answer_cu_kind.
 *  - flat list of tool-call dicts → multi_xy  (Click_Order)
 *  - list of *lists* of tool-call dicts → multi_swap (Bingo) */
function inferAnswerCuKind(cu: unknown): string | null {
  if (!Array.isArray(cu) || cu.length === 0) return null
  const first = cu[0]
  if (first && typeof first === "object" && !Array.isArray(first)
      && ("action" in (first as object) || "name" in (first as object))) {
    return "multi_xy"
  }
  if (Array.isArray(first) && first.length > 0) {
    const inner = first[0] as Record<string, unknown> | unknown
    if (inner && typeof inner === "object"
        && ("action" in (inner as object) || "name" in (inner as object))) {
      return "multi_swap"
    }
  }
  return null
}

export function answerToTrajectory(input: Input): TrajectoryResult {
  const kind = input.answer_cu_kind ?? inferAnswerCuKind(input.answer_cu)
  const cu = input.answer_cu

  switch (kind) {
    case "single_xy": {
      if (!isPair(cu)) break
      return {
        spatial: true,
        kind,
        summary: `click (${cu[0]}, ${cu[1]})`,
        steps: [{ type: "click", x: cu[0], y: cu[1], label: "1" }],
      }
    }

    case "multi_xy": {
      // Accept both legacy [[x,y],...] and new [{action:"click", arguments:{x,y}},...]
      type ClickCall = { action?: string; name?: string; arguments?: { x?: number; y?: number } }
      const isCall = (v: unknown): v is ClickCall =>
        !!v && typeof v === "object" && !Array.isArray(v)
        && ((v as ClickCall).action === "click" || (v as ClickCall).name === "click")
        && !!(v as ClickCall).arguments
        && typeof (v as ClickCall).arguments!.x === "number"
        && typeof (v as ClickCall).arguments!.y === "number"

      if (!Array.isArray(cu) || cu.length === 0) break
      const points: [number, number][] = []
      for (const item of cu as unknown[]) {
        if (isCall(item)) {
          points.push([item.arguments!.x!, item.arguments!.y!])
        } else if (isPair(item)) {
          points.push(item)
        }
      }
      if (points.length === 0) break
      return {
        spatial: true,
        kind,
        summary: `${points.length} clicks in order`,
        steps: points.map((p, i) => ({
          type: "click" as const,
          x: p[0],
          y: p[1],
          label: String(i + 1),
        })),
      }
    }

    case "multi_swap": {
      // Each pair = ONE valid solution (two clicks to swap two cells); when
      // there are multiple pairs they are *alternative* answers, not a
      // sequence. The agent picks any one and then clicks Submit.
      //
      // New format: each pair is a list of explicit tool-call objects
      //   [{name: "click", arguments: {x, y}}, ...]
      // Legacy format ([[x,y],[x,y]]) is still accepted.
      if (!Array.isArray(cu) || cu.length === 0) break

      type ToolCall = {
        action?: string
        name?: string
        arguments?: { x?: number; y?: number }
      }
      const isClickCall = (v: unknown): v is ToolCall => {
        if (!v || typeof v !== "object") return false
        const o = v as ToolCall
        const tag = o.action ?? o.name
        return tag === "click"
          && !!o.arguments
          && typeof o.arguments.x === "number"
          && typeof o.arguments.y === "number"
      }

      const alternatives: TrajectoryStep[][] = []
      for (const pair of cu as unknown[]) {
        if (!Array.isArray(pair) || pair.length !== 2) continue
        let a: [number, number] | null = null
        let b: [number, number] | null = null
        if (isClickCall(pair[0]) && isClickCall(pair[1])) {
          a = [pair[0].arguments!.x!, pair[0].arguments!.y!]
          b = [pair[1].arguments!.x!, pair[1].arguments!.y!]
        } else if (isPair(pair[0]) && isPair(pair[1])) {
          a = pair[0]
          b = pair[1]
        }
        if (!a || !b) continue
        alternatives.push([
          { type: "click", x: a[0], y: a[1], label: "1", note: "swap a" },
          { type: "click", x: b[0], y: b[1], label: "2", note: "swap b" },
        ])
      }
      if (alternatives.length === 0) break
      const altWord = alternatives.length === 1 ? "answer" : "alternatives"
      return {
        spatial: true,
        kind,
        summary: `${alternatives.length} ${altWord} · 2 clicks + submit`,
        steps: alternatives[0],
        alternatives: alternatives.length > 1 ? alternatives : undefined,
        needsSubmit: true,
      }
    }

    case "drag": {
      const obj = cu as { drag?: { from?: [number, number]; to?: [number, number] } } | null
      const drag = obj?.drag
      if (!drag || !isPair(drag.to)) break
      const from = isPair(drag.from) ? drag.from : null
      const step: TrajectoryStep = from
        ? {
            type: "drag",
            fromX: from[0],
            fromY: from[1],
            toX: drag.to[0],
            toY: drag.to[1],
            x: drag.to[0],
            y: drag.to[1],
            label: "1",
            note: `drag to (${drag.to[0]}, ${drag.to[1]})`,
          }
        : {
            type: "drag",
            toX: drag.to[0],
            toY: drag.to[1],
            x: drag.to[0],
            y: drag.to[1],
            label: "→",
            note: `drag target (${drag.to[0]}, ${drag.to[1]})`,
          }
      return {
        spatial: true,
        kind,
        summary: from ? `drag (${from[0]},${from[1]}) → (${drag.to[0]},${drag.to[1]})` : `drag to (${drag.to[0]},${drag.to[1]})`,
        steps: [step],
      }
    }

    case "option": {
      const v = cu as { select_option_index?: number } | null
      const idx = v?.select_option_index
      if (typeof idx !== "number") break
      return {
        spatial: false,
        kind,
        summary: `select option #${idx}`,
        steps: [],
      }
    }

    case "type_text": {
      const v = cu as { type_text?: unknown } | null
      const txt = v?.type_text
      if (txt == null) break
      return {
        spatial: false,
        kind,
        summary: `type "${String(txt)}"`,
        steps: [],
      }
    }

    case "hold": {
      const v = cu as { duration_ms?: number } | null
      const ms = v?.duration_ms
      return {
        spatial: false,
        kind,
        summary: ms != null ? `hold for ${ms} ms` : "hold",
        steps: [],
      }
    }

    case "rotate": {
      const v = cu as { rotate_to_angle?: number } | null
      const a = v?.rotate_to_angle
      return {
        spatial: false,
        kind,
        summary: a != null ? `rotate to ${a}°` : "rotate",
        steps: [],
      }
    }

    case "tool_calls": {
      // Coords are VIEWPORT pixels, NOT image-natural. Without a viz sibling
      // we can't render image-relative dots; just surface a summary text. The
      // iframe playback executes the tool_calls directly regardless.
      type Call = { action?: string; name?: string; arguments?: Record<string, unknown> }
      const hasAlts =
        Array.isArray(cu) && cu.length > 0 && Array.isArray((cu as unknown[])[0])
      const altLists: Call[][] = hasAlts
        ? (cu as unknown[][]).map((alt) => (Array.isArray(alt) ? (alt as Call[]) : []))
        : [(cu as Call[]) || []]
      const firstAlt = altLists[0] || []
      const actionCounts = new Map<string, number>()
      for (const c of firstAlt) {
        const k = String(c?.action || c?.name || "?")
        actionCounts.set(k, (actionCounts.get(k) || 0) + 1)
      }
      const breakdown = Array.from(actionCounts.entries())
        .map(([k, n]) => `${n}× ${k}`)
        .join(" + ")

      // Bingo: answer_cu coords are viewport pixels (don't map to the static
      // image), but the layout-independent `answer` swap indices + grid_size do.
      // Mark the two tiles-to-swap with red dots, in a normalised grid frame so
      // it works on every split's thumbnail without needing dims.json.
      const grid = gridSwapAlternatives(input.answer, input.grid_size)
      if (grid) {
        return {
          spatial: true,
          kind,
          summary:
            grid.alts.length === 1
              ? "swap 2 tiles + submit"
              : `${grid.alts.length} alternatives · swap 2 tiles + submit`,
          steps: grid.alts[0],
          alternatives: grid.alts.length > 1 ? grid.alts : undefined,
          coordSize: grid.coordSize,
          needsSubmit: true,
        }
      }

      // Optional spatial visualisation: viz_natural_xy stores image-natural
      // coords per alt (e.g. Misleading_Click). When present we render dots
      // on the static card image; the alt switcher exposes each alternative.
      const viz = input.viz_natural_xy
      const hasViz = Array.isArray(viz) && viz.length > 0 && Array.isArray(viz[0])
      if (hasViz) {
        const vizAlts: TrajectoryStep[][] = (viz as number[][][]).map((altPairs) =>
          altPairs.flatMap((pair, i) =>
            Array.isArray(pair) && pair.length === 2
              ? [{ type: "click" as const, x: pair[0], y: pair[1], label: String(i + 1) }]
              : [],
          ),
        )
        const firstVizSteps = vizAlts[0] ?? []
        return {
          spatial: true,
          kind,
          summary:
            vizAlts.length > 1
              ? `${vizAlts.length} alts · ${firstVizSteps.length} click${firstVizSteps.length === 1 ? "" : "s"}`
              : `${firstVizSteps.length} click${firstVizSteps.length === 1 ? "" : "s"}`,
          steps: firstVizSteps,
          alternatives: vizAlts.length > 1 ? vizAlts : undefined,
        }
      }

      // No viz sibling — surface per-alt step count via empty-stub alternatives
      // so the modal can still show "#1 (2)" / "#2 (7)" badges.
      const alternatives: TrajectoryStep[][] = altLists.map((alt) =>
        alt.map((_, i) => ({ type: "info" as const, label: String(i + 1) })),
      )
      return {
        spatial: false,
        kind,
        summary: hasAlts
          ? `${altLists.length} alts · ${firstAlt.length} calls (${breakdown})`
          : `${firstAlt.length} calls (${breakdown})`,
        steps: [],
        alternatives: hasAlts ? alternatives : undefined,
      }
    }
  }

  // No usable answer_cu — last-resort fallback.
  return {
    spatial: false,
    kind,
    summary: input.answer_cu == null ? "no answer recorded" : "unrecognised answer format",
    steps: [],
  }
}
