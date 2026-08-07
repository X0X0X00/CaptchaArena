import { useEffect } from "react"
import { ScreenshotWithMarker } from "./ClickMarker"
import type { MarkPoint, MarkDrag } from "../lib/clickMarks"

// A lightbox target is either a bare image URL (legacy callers) or an object
// carrying click-mark overlay info so the zoomed view shows the same red
// circles as the inline thumbnail.
export type LightboxTarget =
  | string
  | { src: string; points?: MarkPoint[]; drags?: MarkDrag[] }

export function Lightbox({
  src,
  onClose,
}: {
  src: LightboxTarget | null
  onClose: () => void
}) {
  useEffect(() => {
    if (!src) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [src, onClose])

  if (!src) return null
  const target = typeof src === "string" ? { src } : src

  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-6 cursor-zoom-out"
      onClick={onClose}
    >
      {/* keyed by src so the marker's measured natural size resets per image */}
      <ScreenshotWithMarker
        key={target.src}
        src={target.src}
        alt="screenshot"
        points={target.points}
        drags={target.drags}
        className="block max-h-[90vh] max-w-[95vw] rounded shadow-2xl"
      />
    </div>
  )
}
