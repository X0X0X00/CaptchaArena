import { useEffect, useLayoutEffect, useRef, useState } from "react"

// Canonical agent viewport — must match computeruse_cli.DEFAULT_WIDTH/HEIGHT and
// PuzzleFrameModal so the inline preview renders the puzzle exactly as the model
// (and the full-screen modal) sees it.
const VIEWPORT_W = 1280
const VIEWPORT_H = 1080

// The real CAPTCHA app (app.py) is served by scripts/run_web_flask.sh on :47860
// (env CAPTCHA_PORT=47860), NOT the old manual :7860. Derive the host from the
// page the viewer was opened from so it works both ways:
//   - opened via the box IP   → http://<box-ip>:47860  (47860 binds 0.0.0.0, no
//     port-forward needed)
//   - opened via an SSH/VS Code tunnel (localhost) → http://localhost:47860
//     (forward 47860 once, same as before)
// Override entirely with VITE_CAPTCHA_SERVER_URL if the app runs elsewhere.
export const CAPTCHA_SERVER_URL = (
  (import.meta.env.VITE_CAPTCHA_SERVER_URL as string | undefined) ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:47860`
    : "http://localhost:47860")
).replace(/\/$/, "")

/**
 * Inline, scaled-down preview of the REAL captcha page (served by app.py), so
 * the dataset card shows the actual interactive task instead of a flat image.
 *
 * - The iframe renders at the canonical 1280×1080 and is CSS-scaled to the card
 *   width, so layout inside matches the agent's view exactly.
 * - `pointer-events-none` + an overlay button: the inline frame is a live
 *   *preview*; clicking opens the full interactive modal. This keeps a grid of
 *   many cards cheap (no focus/scroll capture, one real interaction surface).
 * - Lazy-mounted via IntersectionObserver so off-screen cards don't all hit
 *   Flask at once.
 */
export function LiveCaptchaFrame({
  split,
  puzzleType,
  puzzleId,
  onExpand,
}: {
  split: string
  puzzleType: string
  puzzleId: string
  onExpand?: () => void
}) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(320)
  const [visible, setVisible] = useState(false)

  // Track the card width so we can scale the 1280-wide frame to fit.
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth || 320)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Only mount the iframe once the card scrolls into view.
  useEffect(() => {
    const el = boxRef.current
    if (!el || visible) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: "200px" }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [visible])

  const scale = width / VIEWPORT_W
  const height = VIEWPORT_H * scale

  const params = new URLSearchParams({
    single_puzzle: "true",
    puzzle_type: puzzleType,
    puzzle_id: puzzleId,
    split,
  })
  const src = `${CAPTCHA_SERVER_URL}/?${params.toString()}`

  return (
    <div
      ref={boxRef}
      className="relative w-full overflow-hidden rounded border bg-white"
      style={{ height: height || 240 }}
    >
      {visible ? (
        <iframe
          src={src}
          title={`${puzzleType}/${puzzleId}`}
          width={VIEWPORT_W}
          height={VIEWPORT_H}
          tabIndex={-1}
          scrolling="no"
          className="block border-0 bg-white pointer-events-none"
          style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
          live captcha…
        </div>
      )}
      {/* Click overlay → open the full interactive modal. */}
      <button
        type="button"
        onClick={onExpand}
        title="Open the live interactive CAPTCHA (1280×1080)"
        className="absolute inset-0 cursor-zoom-in"
        aria-label="Open interactive CAPTCHA"
      />
    </div>
  )
}
