// Click-mark data + parsing, kept separate from the components in ClickMarker.tsx
// so that file can export only components (React Fast Refresh requirement).

// A single click point and an optional drag arrow, both expressed in the
// coordinate frame of the underlying screenshot (run screenshots are viewport
// pixels, 1280x1080). Positioning is done in percentages so the marks track the
// click as the image is scaled (thumbnail vs. lightbox).
export interface MarkPoint {
  x: number
  y: number
  label?: string
}

export interface MarkDrag {
  fromX: number
  fromY: number
  toX: number
  toY: number
}

/** Parse a trajectory event's `params` into click points / drag arrows.
 *  Handles single `click` (x,y), multi-point clicks (x/y as arrays, e.g.
 *  multi_xy puzzles), and `drag` (start_x/y → end_x/y). */
export function marksFromParams(
  action: string | null,
  params: Record<string, unknown> | undefined,
  label?: string
): { points: MarkPoint[]; drags: MarkDrag[] } {
  const points: MarkPoint[] = []
  const drags: MarkDrag[] = []
  if (!params) return { points, drags }

  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null

  // Drag arrow (start → end). Detected by action or by the presence of the
  // start/end coordinate fields.
  if (action === "drag" || (params.start_x != null && params.end_x != null)) {
    const fromX = num(params.start_x)
    const fromY = num(params.start_y)
    const toX = num(params.end_x)
    const toY = num(params.end_y)
    if (fromX != null && fromY != null && toX != null && toY != null) {
      drags.push({ fromX, fromY, toX, toY })
      return { points, drags }
    }
  }

  // Click-like actions: x / y, each possibly a list (multi_xy).
  const xs = params.x
  const ys = params.y
  const xArr = Array.isArray(xs) ? xs : xs != null ? [xs] : []
  const yArr = Array.isArray(ys) ? ys : ys != null ? [ys] : []
  const n = Math.max(xArr.length, yArr.length)
  for (let i = 0; i < n; i++) {
    const x = num(xArr[i] ?? xArr[xArr.length - 1])
    const y = num(yArr[i] ?? yArr[yArr.length - 1])
    if (x != null && y != null) {
      points.push({ x, y, label: n > 1 ? `${label ?? ""}·${i + 1}`.replace(/^·/, "") : label })
    }
  }
  return { points, drags }
}
