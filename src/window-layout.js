// Position the pet first, then fit only its bubble to the screen. The pet's
// screen coordinates are independent of the expanded native window bounds.
const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, Math.max(lo, hi)))
function layout({ position, pet, bubble, area, expanded = false, dragging = false, anchors }) {
  const x = Math.round(clamp(position.x, area.x, area.x + area.width - pet.width))
  const y = Math.round(clamp(position.y, area.y, area.y + area.height - pet.height))
  const width = Math.min(bubble.width, area.width)
  const height = Math.min(bubble.height, area.height)
  const bx = Math.round(clamp(x + (pet.width - width) / 2, area.x, area.x + area.width - width))
  const above = y - height >= area.y || y + pet.height + height > area.y + area.height
  const by = Math.round(clamp(above ? y - height : y + pet.height, area.y, area.y + area.height - height))
  const open = { x: Math.min(x, bx), y: Math.min(y, by), width: Math.max(x + pet.width, bx + width) - Math.min(x, bx), height: Math.max(y + pet.height, by + height) - Math.min(y, by) }
  let bounds = expanded ? open : { x, y, width: pet.width, height: pet.height }
  if (dragging && !expanded) {
    const side = Math.ceil(pet.height * 0.28)
    const top = Math.ceil(pet.height * 0.12)
    bounds = { x: x - side, y: y - top, width: pet.width + side * 2, height: pet.height + top }
  }
  const ratio = (offset, space, fallback) => space > 0 ? offset / space : fallback
  const plannedAnchors = {
    anchorX: ratio(x - open.x, open.width - pet.width, 0.5),
    anchorY: ratio(y - open.y, open.height - pet.height, 1),
  }
  const anchor = expanded || dragging
    ? { anchorX: ratio(x - bounds.x, bounds.width - pet.width, plannedAnchors.anchorX), anchorY: ratio(y - bounds.y, bounds.height - pet.height, plannedAnchors.anchorY) }
    : anchors ? { anchorX: anchors.anchorX, anchorY: anchors.anchorY } : plannedAnchors
  return {
    position: { x, y }, bounds,
    stage: { left: x - bounds.x, top: y - bounds.y, width: pet.width, height: pet.height, ...anchor },
    bubble: { left: bx - bounds.x, top: by - bounds.y, width, height, originX: clamp(x + pet.width / 2 - bx, 20, width - 20), originY: above ? height : 0, side: above ? 'above' : 'below' },
  }
}
module.exports = { layout }
