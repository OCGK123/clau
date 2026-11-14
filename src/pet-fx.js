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
    // 음표(콧노래): 동그란 머리, 기둥, 깃발
    note: 'M13.6 2.6c2.2 1.1 4.6 1.9 6 4.4.6 1.1.4 2.4-.5 2.9-.6-1.4-1.9-2.3-3.6-2.8v9.1c0 2.6-2.4 4.6-5.2 4.6-2.2 0-3.8-1.3-3.8-3.1 0-2.4 2.4-4.3 5.2-4.3.5 0 1 .1 1.5.2V3.2c0-.5.2-.8.4-.6z',
  }
  const COLORS = {
    heart: ['#ef6f86', '#f58ca0', '#e85a74'],
    sparkle: ['#f6c445', '#ffd96b', '#ffffff', '#f2a7b8'],
    note: ['#f08a6c', '#f2a7b8', '#f6c445'],
  }
  // 그림과 같은 굵은 밤색 테두리
  const INK = '#3b1d1a'
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
    // 흰 반짝이도 밝은 배경에서 보이도록 얇은 테두리. 음표는 그림처럼 굵은 밤색 테두리.
    path.setAttribute('stroke', kind === 'heart' ? '#b8394f' : kind === 'note' ? INK : '#c98a1e')
    path.setAttribute('stroke-width', kind === 'note' ? '1.6' : '1.2')
    path.setAttribute('paint-order', 'stroke')
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
      const size = kind === 'heart' || kind === 'note' ? rand(16, 23) : rand(14, 21)
      const node = make(kind, size)
      layer.appendChild(node)
      const sx = x - size / 2 + rand(-10, 10) * spread
      const sy = y - size / 2 + rand(-6, 6) * spread
      let frames
      let duration
      if (kind === 'heart' || kind === 'note') {
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

  // 머리 위 표시: 그림처럼 굵은 밤색 테두리 + 단색. 24x24 좌표.
  const MARKS = {
    // 느낌표: 둥근 막대와 점
    bang: { fill: '#f6c445', d: 'M12 2.4c1.6 0 2.6 1.1 2.4 2.7l-.8 9.3c-.1 1-.7 1.6-1.6 1.6s-1.5-.6-1.6-1.6L9.6 5.1C9.4 3.5 10.4 2.4 12 2.4zM12 17.3a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8z' },
    // 물음표: 굵은 선을 두 번(밤색 테두리 위에 색) 그린다
    ask: { fill: '#f08a6c', line: 'M8.4 8.3c.2-2.6 1.8-4.3 3.9-4.3 2.2 0 3.8 1.4 3.8 3.4 0 1.5-.9 2.5-2.2 3.3-1.2.8-1.7 1.4-1.7 2.8v.6', dot: [12.2, 19.2, 1.9] },
    // 땀방울: 밝은 하늘색에 흰 반짝
    sweat: { fill: '#9fd3f0', d: 'M12 2.6c3.1 4.3 5.6 7.6 5.6 10.8a5.6 5.6 0 0 1-11.2 0c0-3.2 2.5-6.5 5.6-10.8z', shine: 'M9.3 13.4c0-1.2.5-2.4 1.3-3.6' },
  }

  /**
   * 머리 위에 작은 표시를 퐁 띄운다. parent 안의 (x, y)가 표시의 아래 가운데.
   * life ms 뒤 스르르 사라진다. life가 0이면 남겨 두고, 돌려준 함수로 치운다.
   */
  function mark(kind, parent, x, y, size = 22, { life = 1100, lean = 0 } = {}) {
    const spec = MARKS[kind]
    if (off || !parent || !spec) return () => {}
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    const add = (tag, attrs) => {
      const node = document.createElementNS(NS, tag)
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
      svg.appendChild(node)
      return node
    }
    if (spec.d) add('path', { d: spec.d, fill: spec.fill, stroke: INK, 'stroke-width': '1.8', 'stroke-linejoin': 'round', 'paint-order': 'stroke' })
    if (spec.shine) add('path', { d: spec.shine, fill: 'none', stroke: '#ffffff', 'stroke-width': '1.4', 'stroke-linecap': 'round' })
    if (spec.line) {
      add('path', { d: spec.line, fill: 'none', stroke: INK, 'stroke-width': '5.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
      add('path', { d: spec.line, fill: 'none', stroke: spec.fill, 'stroke-width': '2.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
      const [cx, cy, r] = spec.dot
      add('circle', { cx, cy, r, fill: spec.fill, stroke: INK, 'stroke-width': '1.8', 'paint-order': 'stroke' })
    }
    svg.style.cssText = `left:${(x - size / 2).toFixed(1)}px;top:${(y - size).toFixed(1)}px;width:${size}px;height:${size}px;transform-origin:50% 100%;`
    parent.appendChild(svg)
    // 퐁: 작게 눌렸다가 위로 쭉, 말랑하게 자리 잡는다.
    svg.animate([
      { transform: `rotate(${lean}deg) scale(0.2, 0.1)`, opacity: 0 },
      { transform: `rotate(${lean}deg) scale(1.15, 1.25)`, opacity: 1, offset: 0.45 },
      { transform: `rotate(${lean}deg) scale(0.92, 0.9)`, offset: 0.72 },
      { transform: `rotate(${lean}deg) scale(1, 1)`, opacity: 1 },
    ], { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' })
    let gone = false
    const remove = (fade = true) => {
      if (gone) return
      gone = true
      if (!fade || !svg.isConnected) return svg.remove()
      const out = svg.animate([{ opacity: 1, transform: `rotate(${lean}deg) scale(1, 1)` }, { opacity: 0, transform: `rotate(${lean}deg) translateY(-30%) scale(0.8, 0.8)` }], { duration: 220, easing: 'ease-in', fill: 'forwards' })
      out.onfinish = () => svg.remove()
      out.oncancel = () => svg.remove()
    }
    if (life > 0) setTimeout(remove, life)
    return remove
  }

  /** 어질어질: 반짝이 셋이 머리 둘레를 빙글빙글 돈다. ms 동안. */
  function orbit(x, y, radius = 26, ms = 2000) {
    if (off || !layer) return
    for (let i = 0; i < 3; i++) {
      if (layer.childElementCount >= MAX_LIVE) return
      const size = radius * 0.32
      const node = make('sparkle', size)
      layer.appendChild(node)
      const start = (i / 3) * 360
      const frames = []
      for (let k = 0; k <= 144; k++) {
        const a = ((start + k * 7.5) * Math.PI) / 180
        const fade = k === 0 ? 0 : k === 144 ? 0 : 1
        frames.push({ transform: `translate(${(x - size / 2 + Math.cos(a) * radius).toFixed(1)}px, ${(y - size / 2 + Math.sin(a) * radius * 0.38).toFixed(1)}px) scale(${k === 0 ? 0.3 : 1})`, opacity: fade })
      }
      const anim = node.animate(frames, { duration: ms, easing: 'linear', fill: 'both' })
      anim.onfinish = () => node.remove()
      anim.oncancel = () => node.remove()
    }
  }

  return {
    mark,
    orbit,
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
