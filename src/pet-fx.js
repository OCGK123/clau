// 상호작용 이펙트: 하트, 반짝이를 잠깐 띄웠다 사라지게 한다.
// 그림은 인라인 SVG(이모지 없음), 움직임은 Web Animations API로 하나씩 랜덤하게.
;(function (root) {
const PetFx = (() => {
  const MAX_LIVE = 24 // 연타로 쌓여도 이 이상은 만들지 않는다(성능)
  const NS = 'http://www.w3.org/2000/svg'
  const SHAPES = {
    // 둥근 하트
    heart: 'M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.9 4.5 6.6 4.5c2.1 0 3.5 1.1 4.4 2.5.9-1.4 2.3-2.5 4.4-2.5 3.7 0 5.7 3.9 4.2 7.3C19.5 16.4 12 21 12 21z',
    // 네 갈래 반짝이
    sparkle: 'M12 1.5c.6 4.6 2.3 7.6 4.6 9.2 1.6 1 3.4 1.2 5.9 1.3-2.5.1-4.3.3-5.9 1.3-2.3 1.6-4 4.6-4.6 9.2-.6-4.6-2.3-7.6-4.6-9.2-1.6-1-3.4-1.2-5.9-1.3 2.5-.1 4.3-.3 5.9-1.3C9.7 9.1 11.4 6.1 12 1.5z',
  }
  const COLORS = {
    heart: ['#ef6f86', '#f58ca0', '#e85a74'],
    sparkle: ['#f6c445', '#ffd96b', '#ffffff', '#f2a7b8'],
  }
  let layer = null
  let off = false

  const rand = (lo, hi) => lo + Math.random() * (hi - lo)
  const pick = list => list[Math.floor(Math.random() * list.length)]

  function make(kind, size) {
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', String(size))
    svg.setAttribute('height', String(size))
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', SHAPES[kind])
    path.setAttribute('fill', pick(COLORS[kind]))
    // 흰 반짝이도 밝은 배경에서 보이도록 얇은 테두리
    path.setAttribute('stroke', kind === 'heart' ? '#b8394f' : '#c98a1e')
    path.setAttribute('stroke-width', '1.2')
    path.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(path)
    svg.style.cssText = `position:absolute;left:0;top:0;width:${size}px;height:${size}px;overflow:visible;pointer-events:none;will-change:transform,opacity;`
    return svg
  }

  /**
   * (x, y) 둘레에 이펙트를 뿌린다. 좌표는 창(body) 기준 px.
   * kind: 'heart'는 위로 둥실 떠오르고, 'sparkle'은 사방으로 톡 튀었다 반짝 사라진다.
   */
  function burst(x, y, kind = 'sparkle', count = 4, spread = 1) {
    if (off || !layer) return
    for (let i = 0; i < count; i++) {
      if (layer.childElementCount >= MAX_LIVE) return
      const size = kind === 'heart' ? rand(16, 23) : rand(14, 21)
      const node = make(kind, size)
      layer.appendChild(node)
      const sx = x - size / 2 + rand(-10, 10) * spread
      const sy = y - size / 2 + rand(-6, 6) * spread
      let frames
      let duration
      if (kind === 'heart') {
        // 아래에서 퐁 나타나 좌우로 살랑이며 위로 떠오른다.
        const drift = rand(-14, 14) * spread
        const rise = rand(34, 56)
        const tilt = rand(-18, 18)
        frames = [
          { transform: `translate(${sx}px, ${sy}px) scale(0.2) rotate(${tilt}deg)`, opacity: 0 },
          { transform: `translate(${sx + drift * 0.3}px, ${sy - rise * 0.2}px) scale(1.15) rotate(${tilt * 0.4}deg)`, opacity: 1, offset: 0.2 },
          { transform: `translate(${sx - drift * 0.2}px, ${sy - rise * 0.6}px) scale(1) rotate(${-tilt * 0.3}deg)`, opacity: 1, offset: 0.6 },
          { transform: `translate(${sx + drift}px, ${sy - rise}px) scale(0.85) rotate(${tilt * 0.2}deg)`, opacity: 0 },
        ]
        duration = rand(900, 1200)
      } else {
        // 바깥쪽으로 톡 튀어 나가며 커졌다가, 빙글 돌며 작아지고 사라진다.
        const angle = rand(0, Math.PI * 2)
        const dist = rand(20, 36) * spread
        const ex = sx + Math.cos(angle) * dist
        const ey = sy + Math.sin(angle) * dist - 6
        const spin = rand(60, 140) * (Math.random() < 0.5 ? -1 : 1)
        frames = [
          { transform: `translate(${sx}px, ${sy}px) scale(0) rotate(0deg)`, opacity: 1 },
          { transform: `translate(${sx + (ex - sx) * 0.55}px, ${sy + (ey - sy) * 0.55}px) scale(1.15) rotate(${spin * 0.35}deg)`, opacity: 1, offset: 0.3 },
          { transform: `translate(${sx + (ex - sx) * 0.85}px, ${sy + (ey - sy) * 0.85}px) scale(0.9) rotate(${spin * 0.7}deg)`, opacity: 1, offset: 0.62 },
          { transform: `translate(${ex}px, ${ey}px) scale(0) rotate(${spin}deg)`, opacity: 0 },
        ]
        duration = rand(760, 960)
      }
      const anim = node.animate(frames, {
        duration,
        delay: i * rand(25, 55),
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'both',
      })
      anim.onfinish = () => node.remove()
      anim.oncancel = () => node.remove()
    }
  }

  return {
    /** 이펙트를 그릴 층(창 전체를 덮는 투명 div)을 정한다. */
    attach(node) {
      layer = node
    },
    /** 움직임 줄이기가 켜지면 이펙트도 끈다. */
    setOff(on) {
      off = !!on
      if (off && layer) layer.replaceChildren()
    },
    burst,
  }
})()
  root.PetFx = PetFx
})(typeof window === 'undefined' ? globalThis : window)
