const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const BubbleShape = require('../src/bubble-shape')

const viewport = { width: 340, height: 224 }
const bounds = points => ({
  left: Math.min(...points.map(point => point.x)), right: Math.max(...points.map(point => point.x)),
  top: Math.min(...points.map(point => point.y)), bottom: Math.max(...points.map(point => point.y)),
})
const close = (one, two) => assert.ok(Math.abs(one - two) < 1e-8, `${one} equals ${two}`)

test('the outline has identical cubic topology through every opening and closing frame', () => {
  for (const side of ['above', 'below']) {
    const layout = { ...viewport, side, originX: 275, originY: side === 'above' ? 222 : 2 }
    let commands
    for (let frame = 0; frame <= 40; frame++) {
      const progress = frame <= 20 ? frame / 20 : 2 - frame / 20
      const points = BubbleShape.points(progress, layout)
      assert.equal(points.length, 34)
      const d = BubbleShape.path(points)
      const current = d.match(/[A-Za-z]/g).join('')
      assert.equal(current, 'M' + 'C'.repeat(11) + 'Z')
      if (commands) assert.equal(current, commands)
      commands = current
      assert.equal(/NaN|Infinity/.test(d), false)
    }
  }
})

test('start is a tiny droplet and endpoint is the full body with the requested tail', () => {
  for (const side of ['above', 'below']) {
    const layout = { ...viewport, side, originX: 92, originY: side === 'above' ? 222 : 2 }
    const start = BubbleShape.points(0, layout)
    const end = BubbleShape.points(1, layout)
    const tiny = bounds(start)
    const full = bounds(end)
    close(tiny.right - tiny.left, 8)
    close(tiny.bottom - tiny.top, 8)
    assert.deepEqual(full, { left: 2, right: 338, top: 2, bottom: 222 })
    assert.deepEqual(end[18], { x: 92, y: side === 'above' ? 222 : 2 })
    assert.deepEqual(end[15], { x: 98, y: side === 'above' ? 210 : 14 })
    assert.deepEqual(end[21], { x: 86, y: side === 'above' ? 210 : 14 })
  }
})

test('a circular droplet becomes a round pill before its corners settle into the panel', () => {
  const layout = { ...viewport, side: 'above', originX: 170, originY: 222 }
  const frame = progress => {
    const points = BubbleShape.points(progress, layout)
    return {
      points,
      radius: points[0].x - points[27].x,
      bodyHeight: points[12].y - points[0].y,
      bodyWidth: points[6].x - points[27].x,
    }
  }
  const start = frame(0)
  const early = frame(0.25)
  const middle = frame(0.5)
  const late = frame(0.8)
  const end = frame(1)
  close(start.radius, 4)
  close(start.bodyWidth, 8)
  close(start.bodyHeight, 8)
  close(early.radius, early.bodyHeight / 2)
  assert.ok(middle.radius > middle.bodyHeight * 0.43, 'middle stays visibly round')
  assert.ok(middle.radius > 45, 'midway corners remain bulbous rather than 16px panel corners')
  assert.ok(late.radius < middle.radius, 'corners settle while the body continues expanding')
  assert.ok(late.bodyWidth > middle.bodyWidth)
  close(end.radius, 16)
  // Final outline remains exactly the requested 16px rounded speech panel.
  assert.deepEqual(end.points[0], { x: 18, y: 2 })
  assert.deepEqual(end.points[3], { x: 322, y: 2 })
  assert.deepEqual(end.points[6], { x: 338, y: 18 })
  assert.deepEqual(end.points[12], { x: 322, y: 210 })
  close(end.points[18].y - end.points[15].y, 12)
  // One fixed point anchors the tail while the body, corners and base change.
  for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
    assert.deepEqual(frame(progress).points[18], { x: 170, y: 222 })
  }
  // Uniform scale or linear point interpolation cannot produce this middle corner.
  assert.ok(Math.abs(middle.points[0].x - (start.points[0].x + end.points[0].x) / 2) > 20)
})

test('corner-anchored tails attach within the pill edge instead of crossing its round corners', () => {
  for (const originX of [24, 316]) for (const progress of [0.01, 0.1, 0.25, 0.5, 0.75, 1]) {
    const points = BubbleShape.points(progress, { ...viewport, originX, originY: 222 })
    const cornerLeft = points[24].x
    const cornerRight = points[12].x
    assert.ok(points[21].x >= cornerLeft - 1e-8, 'tail left base follows the flat lower edge')
    assert.ok(points[15].x <= cornerRight + 1e-8, 'tail right base follows the flat lower edge')
    assert.ok(points[21].x <= points[15].x + 1e-8)
    assert.deepEqual(points[18], { x: originX, y: 222 })
  }
})

test('bounds expand monotonically and every control point stays inside the viewport', () => {
  for (const side of ['above', 'below']) for (const originX of [-50, 24, 170, 316, 400]) {
    let previous = null
    for (let frame = 0; frame <= 30; frame++) {
      const points = BubbleShape.points(frame / 30, { ...viewport, side, originX })
      const current = bounds(points)
      for (const point of points) {
        assert.ok(point.x >= 2 - 1e-8 && point.x <= 338 + 1e-8)
        assert.ok(point.y >= 2 - 1e-8 && point.y <= 222 + 1e-8)
      }
      if (previous) {
        assert.ok(current.left <= previous.left + 1e-8)
        assert.ok(current.right >= previous.right - 1e-8)
        assert.ok(current.top <= previous.top + 1e-8)
        assert.ok(current.bottom >= previous.bottom - 1e-8)
      }
      previous = current
    }
  }
})

test('below geometry is the exact vertical mirror of the above outline', () => {
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    const above = BubbleShape.points(progress, { ...viewport, side: 'above', originX: 240, originY: 190 })
    const below = BubbleShape.points(progress, { ...viewport, side: 'below', originX: 240, originY: 34 })
    above.forEach((point, index) => {
      close(point.x, below[index].x)
      close(point.y + below[index].y, viewport.height)
    })
  }
})

test('tail x is clamped at both corners and progress cannot overshoot', () => {
  assert.equal(BubbleShape.points(1, { ...viewport, originX: -100 })[18].x, 24)
  assert.equal(BubbleShape.points(1, { ...viewport, originX: 999 })[18].x, 316)
  assert.deepEqual(BubbleShape.points(-1, viewport), BubbleShape.points(0, viewport))
  assert.deepEqual(BubbleShape.points(2, viewport), BubbleShape.points(1, viewport))
  assert.deepEqual(BubbleShape.points(NaN, viewport), BubbleShape.points(0, viewport))
  assert.throws(() => BubbleShape.path([]), /34 finite/)
})

test('browser global API matches CommonJS without a module loader', () => {
  const context = vm.createContext({ window: {} })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/bubble-shape.js'), 'utf8'), context)
  assert.equal(typeof context.window.BubbleShape.points, 'function')
  const browser = context.window.BubbleShape
  assert.equal(browser.path(browser.points(0.5, viewport)), BubbleShape.path(BubbleShape.points(0.5, viewport)))
})
