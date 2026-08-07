import { useState } from "react"
import type { ReactEventHandler } from "react"
import type { MarkPoint, MarkDrag } from "../lib/clickMarks"

/** Absolute overlay drawn inside a `relative` parent: a hollow red ring +
 *  crosshair per click point, plus red arrows for drags. `pointer-events-none`
 *  so it never blocks clicks on the image beneath it. */
export function OverlayMarks({
  coordSize,
  points = [],
  drags = [],
}: {
  coordSize: { w: number; h: number }
  points?: MarkPoint[]
  drags?: MarkDrag[]
}) {
  const px = (v: number, total: number) => (total > 0 ? (v / total) * 100 : 0)

  return (
    <div className="absolute inset-0 pointer-events-none">
      {drags.length > 0 && (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full"
        >
          <defs>
            <marker
              id="clickArrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="4"
              markerHeight="4"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(220 38 38)" />
            </marker>
          </defs>
          {drags.map((d, i) => (
            <line
              key={`drag-${i}`}
              x1={px(d.fromX, coordSize.w)}
              y1={px(d.fromY, coordSize.h)}
              x2={px(d.toX, coordSize.w)}
              y2={px(d.toY, coordSize.h)}
              stroke="rgb(220 38 38)"
              strokeWidth="0.5"
              vectorEffect="non-scaling-stroke"
              markerEnd="url(#clickArrow)"
            />
          ))}
        </svg>
      )}

      {points.map((p, i) => (
        <div
          key={`pt-${i}`}
          style={{
            left: `${px(p.x, coordSize.w)}%`,
            top: `${px(p.y, coordSize.h)}%`,
            transform: "translate(-50%, -50%)",
          }}
          className="absolute"
        >
          {/* hollow ring with a white halo so it stays visible on any background */}
          <div className="h-6 w-6 rounded-full border-[3px] border-red-600 shadow-[0_0_0_1.5px_rgba(255,255,255,0.85)]" />
          {/* crosshair */}
          <div className="absolute left-1/2 top-1/2 h-[1.5px] w-8 -translate-x-1/2 -translate-y-1/2 bg-red-600/80" />
          <div className="absolute left-1/2 top-1/2 h-8 w-[1.5px] -translate-x-1/2 -translate-y-1/2 bg-red-600/80" />
          {p.label != null && p.label !== "" && (
            <div className="absolute left-1/2 -top-3 -translate-x-1/2 whitespace-nowrap rounded bg-red-600 px-1 text-[9px] font-bold leading-tight text-white shadow">
              {p.label}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** An <img> wrapped in a relative container with click-mark overlay. Tracks the
 *  image's natural size on load and uses it as the coordinate frame, so the
 *  caller only supplies click coords in screenshot pixels. Remount (via a `key`
 *  on the parent) to reset the measured size when the image source changes. */
export function ScreenshotWithMarker({
  src,
  alt,
  points,
  drags,
  className,
  onClick,
  onError,
}: {
  src: string
  alt?: string
  points?: MarkPoint[]
  drags?: MarkDrag[]
  className?: string
  onClick?: () => void
  onError?: ReactEventHandler<HTMLImageElement>
}) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const hasMarks = (points && points.length > 0) || (drags && drags.length > 0)
  return (
    <div className="relative inline-block leading-none">
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={(e) => {
          const im = e.currentTarget
          setNatural({ w: im.naturalWidth, h: im.naturalHeight })
        }}
        onClick={onClick}
        onError={onError}
        className={className}
      />
      {natural && hasMarks && <OverlayMarks coordSize={natural} points={points} drags={drags} />}
    </div>
  )
}
