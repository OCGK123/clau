const { test } = require('node:test')
const assert = require('node:assert/strict')
const { layout } = require('../src/window-layout')

const area = { x: 0, y: 0, width: 1920, height: 1080 }
const pet = { width: 180, height: 220 }
const bubble = { width: 340, height: 210 }
const rectOnScreen = (result, part) => ({
  x: result.bounds.x + result[part].left,
  y: result.bounds.y + result[part].top,
  width: result[part].width,
  height: result[part].height,
})
const stagePoint = result => {
  const stage = rectOnScreen(result, 'stage')
  return { x: stage.x, y: stage.y }
}
const contains = (outer, inner) => {
  assert.ok(inner.x >= outer.x, 'left edge fits')
  assert.ok(inner.y >= outer.y, 'top edge fits')
  assert.ok(inner.x + inner.width <= outer.x + outer.width, 'right edge fits')
  assert.ok(inner.y + inner.height <= outer.y + outer.height, 'bottom edge fits')
}

for (const [name, position] of [
  ['top left', { x: 0, y: 0 }],
  ['top right', { x: 1740, y: 0 }],
  ['bottom left', { x: 0, y: 860 }],
  ['bottom right', { x: 1740, y: 860 }],
]) {
  test(`chat open and close keep exact character coordinates at ${name}`, () => {
    const closed = layout({ position, pet, bubble, area })
    const open = layout({ position, pet, bubble, area, expanded: true })
    const closedAgain = layout({ position: open.position, pet, bubble, area, anchors: { anchorX: open.stage.anchorX, anchorY: open.stage.anchorY } })
    assert.deepEqual(stagePoint(closed), position)
    assert.deepEqual(stagePoint(open), position)
    assert.deepEqual(stagePoint(closedAgain), position)
    assert.deepEqual(open.position, closed.position)
    assert.equal(closedAgain.stage.anchorX, open.stage.anchorX)
    assert.equal(closedAgain.stage.anchorY, open.stage.anchorY)
    contains(area, rectOnScreen(open, 'bubble'))
    contains(open.bounds, rectOnScreen(open, 'stage'))
    contains(open.bounds, rectOnScreen(open, 'bubble'))
    assert.equal(open.bubble.side, position.y === 0 ? 'below' : 'above')
  })
}

test('bubble chooses above when there is room and below near the upper edge', () => {
  const above = layout({ position: { x: 600, y: 500 }, pet, bubble, area, expanded: true })
  const below = layout({ position: { x: 600, y: 80 }, pet, bubble, area, expanded: true })
  const aboveRect = rectOnScreen(above, 'bubble')
  const belowRect = rectOnScreen(below, 'bubble')
  assert.equal(above.bubble.side, 'above')
  assert.equal(aboveRect.y + aboveRect.height, 500)
  assert.equal(above.bubble.originY, bubble.height)
  assert.equal(below.bubble.side, 'below')
  assert.equal(belowRect.y, 80 + pet.height)
  assert.equal(below.bubble.originY, 0)
})

test('a bubble touching either horizontal edge is clamped without moving the pet', () => {
  for (const position of [{ x: 20, y: 400 }, { x: 1710, y: 400 }]) {
    const closed = layout({ position, pet, bubble, area })
    const open = layout({ position, pet, bubble, area, expanded: true })
    assert.deepEqual(stagePoint(open), stagePoint(closed))
    assert.deepEqual(stagePoint(open), position)
    const shown = rectOnScreen(open, 'bubble')
    contains(area, shown)
    assert.equal(shown.x, position.x < area.width / 2 ? 0 : area.width - bubble.width)
    assert.equal(open.bubble.originX, position.x + pet.width / 2 - shown.x)
  }
})

test('out-of-work-area position is clamped once and remains stable across chat toggles', () => {
  const position = { x: 5000, y: -200 }
  const closed = layout({ position, pet, bubble, area })
  const open = layout({ position, pet, bubble, area, expanded: true })
  assert.deepEqual(closed.position, { x: area.width - pet.width, y: 0 })
  assert.deepEqual(open.position, closed.position)
  assert.deepEqual(stagePoint(open), stagePoint(closed))
})

test('negative display origins preserve exact global character coordinates', () => {
  const leftDisplay = { x: -1600, y: -200, width: 1600, height: 900 }
  for (const position of [{ x: -1600, y: -200 }, { x: -180, y: 480 }, { x: -925, y: 130 }]) {
    const open = layout({ position, pet, bubble, area: leftDisplay, expanded: true })
    assert.deepEqual(stagePoint(open), position)
    contains(leftDisplay, rectOnScreen(open, 'bubble'))
    contains(open.bounds, rectOnScreen(open, 'stage'))
    contains(open.bounds, rectOnScreen(open, 'bubble'))
  }
})

test('large pet and a narrow work area keep stage size and produce finite geometry', () => {
  const smallArea = { x: -320, y: 50, width: 320, height: 600 }
  const largePet = { width: 470, height: 800 }
  const closed = layout({ position: { x: -250, y: 80 }, pet: largePet, bubble, area: smallArea })
  const open = layout({ position: closed.position, pet: largePet, bubble, area: smallArea, expanded: true })
  assert.deepEqual(closed.position, { x: -320, y: 50 })
  assert.deepEqual(stagePoint(open), closed.position)
  assert.equal(open.stage.width, largePet.width)
  assert.equal(open.stage.height, largePet.height)
  assert.equal(open.bubble.width, smallArea.width)
  contains(smallArea, rectOnScreen(open, 'bubble'))
  for (const block of [open.bounds, open.stage, open.bubble]) {
    for (const value of Object.values(block)) if (typeof value === 'number') assert.ok(Number.isFinite(value))
  }
})

test('holding adds exact transparent rotation room while preserving the pickup position', () => {
  const oddPet = { width: 181, height: 223 }
  const radius = Math.ceil(Math.hypot(oddPet.width, oddPet.height))
  for (const position of [{ x: 0, y: 0 }, { x: 1739, y: 857 }, { x: 500, y: 300 }]) {
    const held = layout({ position, pet: oddPet, bubble, area, dragging: true })
    const released = layout({ position: held.position, pet: oddPet, bubble, area })
    assert.deepEqual(stagePoint(held), position)
    assert.deepEqual(stagePoint(released), position)
    assert.deepEqual(held.bounds, { x: position.x - radius, y: position.y - radius, width: oddPet.width + radius * 2, height: oddPet.height + radius * 2 })
    assert.equal(held.stage.left, radius)
    assert.equal(held.stage.top, radius)
    assert.equal(held.stage.anchorX, 0.5)
    assert.equal(held.stage.anchorY, 0.5)
    assert.equal(released.bounds.width, oddPet.width)
    assert.equal(released.bounds.height, oddPet.height)
  }
})

test('expanded holding uses bubble bounds and closed layout keeps supplied morph anchors', () => {
  const position = { x: 20, y: 40 }
  const open = layout({ position, pet, bubble, area, expanded: true })
  const openHeld = layout({ position, pet, bubble, area, expanded: true, dragging: true })
  assert.deepEqual(openHeld.bounds, open.bounds)
  assert.deepEqual(stagePoint(openHeld), position)
  const anchors = { anchorX: 0.125, anchorY: 0 }
  const closed = layout({ position, pet, bubble, area, anchors })
  assert.equal(closed.stage.anchorX, anchors.anchorX)
  assert.equal(closed.stage.anchorY, anchors.anchorY)
  assert.deepEqual(stagePoint(closed), position)
})

test('layout is deterministic and does not mutate caller objects', () => {
  const input = Object.freeze({ position: Object.freeze({ x: 690.2, y: 570.7 }), pet: Object.freeze(pet), bubble: Object.freeze(bubble), area: Object.freeze(area), expanded: true })
  const one = layout(input)
  const two = layout(input)
  assert.deepEqual(two, one)
  assert.deepEqual(one.position, { x: 690, y: 571 })
  assert.deepEqual(input.position, { x: 690.2, y: 570.7 })
})

test('retaining a previous full stage object never overwrites new stage size or offsets', () => {
  const old = layout({ position: { x: 500, y: 400 }, pet, bubble, area, expanded: true })
  const resizedPet = { width: 300, height: 360 }
  const next = layout({ position: { x: 500, y: 400 }, pet: resizedPet, bubble, area, anchors: old.stage })
  assert.equal(next.stage.width, 300)
  assert.equal(next.stage.height, 360)
  assert.equal(next.stage.left, 0)
  assert.equal(next.stage.top, 0)
  assert.deepEqual(stagePoint(next), { x: 500, y: 400 })
})


test('full rotations at every pickup corner fit both full and bust artwork, including flipping', () => {
  for (const view of ['full', 'bust']) {
    const height = 220
    const width = view === 'bust' ? 266 : 184
    const art = { width, height, artWidth: width * 0.94, artHeight: height * 0.94 / (view === 'bust' ? 0.69 : 1), artTop: height * 0.06 }
    const position = { x: 0, y: 0 }
    const held = layout({ position, pet: art, bubble, area, dragging: true })
    assert.deepEqual(stagePoint(held), position)
    assert.equal(held.stage.anchorX, 0.5)
    assert.equal(held.stage.anchorY, 0.5)
    assert.ok(held.bounds.x < area.x && held.bounds.y < area.y, 'native gutters stay outside the work area instead of shifting the stage')
    const left = (width - art.artWidth) / 2
    for (const flip of [false, true]) for (const pivot of [{x:0,y:0},{x:width,y:0},{x:0,y:height},{x:width,y:height},{x:width/2,y:height/2}]) {
      for (let degrees = -720; degrees <= 720; degrees += 15) {
        const radians = degrees * Math.PI / 180
        for (const corner of [{x:left,y:art.artTop},{x:left+art.artWidth,y:art.artTop},{x:left,y:art.artTop+art.artHeight},{x:left+art.artWidth,y:art.artTop+art.artHeight}]) {
          const localX = (flip ? width - corner.x : corner.x) - pivot.x
          const localY = corner.y - pivot.y
          const x = position.x + pivot.x + localX * Math.cos(radians) - localY * Math.sin(radians)
          const y = position.y + pivot.y + localX * Math.sin(radians) + localY * Math.cos(radians)
          assert.ok(x >= held.bounds.x && x <= held.bounds.x + held.bounds.width, `${view} X fits at ${degrees} degrees`)
          assert.ok(y >= held.bounds.y && y <= held.bounds.y + held.bounds.height, `${view} Y fits at ${degrees} degrees`)
        }
      }
    }
  }
})
