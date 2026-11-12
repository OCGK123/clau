// A held character behaves like a damped pendulum, driven only by hand motion.
// Kept independent of the DOM so timing and input strength can be tested.
;(function (root) {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  function create({ length = 110, maxAngle = 0.42 } = {}) {
    let angle = 0
    let velocity = 0
    let handVelocity = 0
    let lastX = 0
    let lastAt = 0
    let now = 0
    let active = false
    const arm = Math.max(35, length)
    const kick = delta => { velocity += clamp(delta / arm * 0.42, -7, 7) }

    return {
      begin(x, at) {
        angle = velocity = handVelocity = 0
        lastX = x
        now = lastAt = at
        active = true
      },
      move(x, at) {
        if (!active || !Number.isFinite(x) || !Number.isFinite(at) || at <= lastAt) return
        const seconds = Math.max(0.008, (at - lastAt) / 1000)
        const next = clamp((x - lastX) / seconds, -2400, 2400)
        kick(next - handVelocity)
        handVelocity = next
        lastX = x
        lastAt = at
      },
      step(at) {
        if (!active || !Number.isFinite(at)) return 0
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
          if (Math.abs(angle) > maxAngle) {
            angle = Math.sign(angle) * maxAngle
            if (Math.sign(velocity) === Math.sign(angle)) velocity *= -0.12
          }
          remaining -= dt
        }
        if (Math.abs(angle) < 0.00002 && Math.abs(velocity) < 0.0001) angle = velocity = 0
        return angle * 180 / Math.PI
      },
      stop() {
        active = false
        angle = velocity = handVelocity = 0
        return 0
      },
      isSettled() { return angle === 0 && velocity === 0 && handVelocity === 0 },
    }
  }

  const api = { create }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.PetMotion = api
})(typeof window === 'undefined' ? globalThis : window)
