// The speech outline itself changes geometry. Every frame has the same eleven
// cubic segments, so opening and closing never substitute a scaled rectangle.
;(function (root) {
  const KAPPA = 0.5522847498307936
  const clamp = (value, low, high) => Math.max(low, Math.min(value, high))
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback

  function outline({ left, right, top, bottom, radius, tailX, tailY, tailHalf, tailBaseX = tailX }) {
    const p = (x, y) => ({ x, y })
    const points = [p(left + radius, top)]
    let current = points[0]
    const cubic = (one, two, end) => { points.push(one, two, end); current = end }
    const line = end => cubic(
      p(current.x + (end.x - current.x) / 3, current.y + (end.y - current.y) / 3),
      p(current.x + (end.x - current.x) * 2 / 3, current.y + (end.y - current.y) * 2 / 3), end,
    )
    const k = radius * KAPPA
    line(p(right - radius, top))
    cubic(p(right - radius + k, top), p(right, top + radius - k), p(right, top + radius))
    line(p(right, bottom - radius))
    cubic(p(right, bottom - radius + k), p(right - radius + k, bottom), p(right - radius, bottom))
    line(p(tailBaseX + tailHalf, bottom))
    const tailHeight = tailY - bottom
    cubic(p(tailBaseX + tailHalf * 0.8, bottom + tailHeight * 0.4), p(tailX + tailHalf * 0.3, tailY - tailHeight * 0.08), p(tailX, tailY))
    cubic(p(tailX - tailHalf * 0.2, tailY - tailHeight * 0.3), p(tailBaseX - tailHalf * 0.8, bottom + tailHeight * 0.08), p(tailBaseX - tailHalf, bottom))
    line(p(left + radius, bottom))
    cubic(p(left + radius - k, bottom), p(left, bottom - radius + k), p(left, bottom - radius))
    line(p(left, top + radius))
    cubic(p(left, top + radius - k), p(left + radius - k, top), p(left + radius, top))
    return points
  }

  /** A flat [move, c1, c2, end, ...] array with a fixed M + 11C + Z topology. */
  function points(progress, layout = {}) {
    const width = Math.max(48, finite(layout.width, 340))
    const height = Math.max(40, finite(layout.height, 224))
    const below = layout.side === 'below'
    const tailX = clamp(finite(layout.originX, width / 2), 24, width - 24)
    const defaultY = below ? 2 : height - 2
    const originY = finite(layout.originY, defaultY)
    // Construct both variants facing down, then mirror the below variant. The
    // tiny initial droplet is wholly inside the same viewport as the final body.
    const tip = clamp(below ? height - originY : originY, 12, height - 2)
    const t = clamp(finite(progress, 0), 0, 1)
    const mix = (from, to) => from + (to - from) * t
    const left = mix(tailX - 4, 2)
    const right = mix(tailX + 4, width - 2)
    const top = mix(tip - 8, 2)
    const bottom = mix(tip, height - 14)
    const tailY = mix(tip, height - 2)

    // Start as a circle, grow into a soft pill, then let the corners settle
    // into the final panel late in the reveal. A constant/linearly blended
    // corner radius would just look like a small rectangle being enlarged.
    const roundRadius = Math.min(right - left, bottom - top) / 2
    const finalRadius = Math.min(16, (height - 16) / 2)
    const late = clamp((t - 0.35) / 0.65, 0, 1)
    const settle = late * late * (3 - 2 * late)
    const radius = roundRadius + (finalRadius - roundRadius) * settle

    // Near a screen corner the rounded body initially has no flat lower edge.
    // Attach the tail on that edge as it appears, without letting its base
    // cross a corner. The tip keeps its independent character-side anchor.
    const flatHalf = Math.max(0, (right - left) / 2 - radius)
    const tailHalf = Math.min(6 * t, flatHalf)
    const tailBaseX = clamp(tailX, left + radius + tailHalf, right - radius - tailHalf)
    return outline({ left, right, top, bottom, radius, tailX, tailY, tailHalf, tailBaseX }).map(point => ({
      x: point.x, y: below ? height - point.y : point.y,
    }))
  }

  function path(points) {
    if (!Array.isArray(points) || points.length !== 34 || points.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
      throw new TypeError('A bubble path requires 34 finite Bézier points.')
    }
    const coord = point => `${Number(point.x.toFixed(3))} ${Number(point.y.toFixed(3))}`
    let d = `M${coord(points[0])}`
    for (let index = 1; index < points.length; index += 3) d += ` C${coord(points[index])} ${coord(points[index + 1])} ${coord(points[index + 2])}`
    return `${d} Z`
  }

  const api = { points, path }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.BubbleShape = api
})(typeof window === 'undefined' ? globalThis : window)
