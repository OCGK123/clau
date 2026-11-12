// A held character behaves like a damped pendulum, driven only by hand motion.
// Kept independent of the DOM so timing and input strength can be tested.
;(function (root) {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  const TURN = Math.PI * 2

  function create({ length = 110 } = {}) {
    let angle = 0
    let velocity = 0
    let handVelocity = 0
    let lastX = 0
    let lastAt = 0
    let now = 0
    let active = false
    let settled = true
    const arm = Number.isFinite(length) ? Math.max(35, length) : 110
    const kick = delta => {
      velocity += delta / arm * 0.42
      if (delta !== 0) settled = false
    }

    return {
      begin(x, at) {
        angle = velocity = handVelocity = 0
        lastX = Number.isFinite(x) ? x : 0
        now = lastAt = Number.isFinite(at) ? at : 0
        active = Number.isFinite(x) && Number.isFinite(at)
        settled = true
      },
      move(x, at) {
        if (!active || !Number.isFinite(x) || !Number.isFinite(at) || at <= lastAt) return
        const seconds = Math.max(0.008, (at - lastAt) / 1000)
        // This bounds malformed pointer samples, not the angle or number of
        // turns. Ordinary mouse velocities keep their proportional response.
        const next = clamp((x - lastX) / seconds, -100000, 100000)
        kick(next - handVelocity)
        handVelocity = next
        lastX = x
        lastAt = at
      },
      step(at) {
        if (!active || !Number.isFinite(at)) return 0
        if (at < now || settled) return angle * 180 / Math.PI
        // A stationary pointer emits no events; still account for its stopping.
        if (at - lastAt > 70 && handVelocity !== 0) {
          kick(-handVelocity)
          handVelocity = 0
        }
        let remaining = clamp((at - now) / 1000, 0, 0.064)
        now = at
        while (remaining > 0) {
          const dt = Math.min(remaining, 1 / 240)
          const gravity = 2600 / arm
          velocity += (-gravity * Math.sin(angle) - 4.2 * velocity) * dt
          angle += velocity * dt
          remaining -= dt
        }
        // A pendulum can settle after any whole number of revolutions. Snap
        // only its tiny residual angle, never its accumulated turn count.
        const restingAngle = Math.round(angle / TURN) * TURN || 0
        if (handVelocity === 0 && Math.abs(angle - restingAngle) < 0.00002 && Math.abs(velocity) < 0.0001) {
          angle = restingAngle
          velocity = 0
          settled = true
        }
        return angle * 180 / Math.PI
      },
      stop() {
        active = false
        angle = velocity = handVelocity = 0
        settled = true
        return 0
      },
      isSettled() { return settled && handVelocity === 0 },
    }
  }

  const api = { create }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.PetMotion = api
})(typeof window === 'undefined' ? globalThis : window)
