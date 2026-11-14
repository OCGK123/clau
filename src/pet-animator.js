// 몸짓 엔진(PetAnimator): 상태별 움직임을 계산하고, 상태가 바뀌면 지금 모습에서 새 움직임으로 부드럽게 넘어간다.
// CSS 키프레임은 클래스가 바뀌는 순간 0% 프레임으로 툭 튀어서, 쓰다듬다 웃을 때 끊겨 보였다.
// pet-motion.js(집어 들었을 때의 진자 운동)와는 별개다. 이쪽은 상태별 몸짓을 맡고, 몸(.body)을 감싸는
// .mover에 transform을 준다. 그래서 진자 회전·boing과 겹쳐도 서로 덮어쓰지 않고 합쳐진다.
//
// 배터리: 움직이는 모든 것(몸, 작은 친구, 작은 친구의 둥실거림, 얼굴 출렁임, 잠꼬대 z)을 이 루프 하나가 그린다.
// CSS의 무한 반복 애니메이션은 쉬지 않고 1초에 60번 화면을 다시 그리게 해서 뺐다.
// 느린 움직임(숨쉬기, 둥실)은 1초에 20번(배터리로 돌 땐 12번)만 깨어나 그리고, 빠른 움직임(폴짝, 말랑)만
// 화면 주기(60번)에 맞춰 그린다. 눈에 띄지 않을 만큼(0.1px 안팎) 바뀐 프레임은 아예 쓰지 않는다.
;(function (root) {
const PetAnimator = (() => {
  const BLEND_MS = 170 // 상태가 바뀔 때 앞 움직임에서 새 움직임으로 섞는 시간(짧을수록 반응이 빠르다)
  // 찰짐 세기: 모든 눌림·늘어남·뜀의 크기를 한꺼번에 키우거나 줄인다. 1 = 원래 값.
  const JUICE = 1.4
  const TAU = Math.PI * 2
  const ID = { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 }
  const SQUISH_S = 0.52 // 쓰다듬기 말랑 한 주기(초)

  const easeOut = p => 1 - (1 - p) ** 3
  const smooth = p => p * p * (3 - 2 * p)
  /** 0→1→0 을 매끈하게 오가는 파동 (CSS alternate + ease-in-out 과 같은 모양). */
  const wave = (t, period) => (1 - Math.cos((TAU * t) / period)) / 2
  /** [위치, 값] 키프레임 사이를 smoothstep으로 잇는다. p는 0~1. */
  function keys(p, frames) {
    for (let i = 1; i < frames.length; i++) {
      const [p1, v1] = frames[i]
      const [p0, v0] = frames[i - 1]
      if (p <= p1) {
        const k = smooth((p - p0) / (p1 - p0 || 1))
        return v0.map((v, j) => v + (v1[j] - v) * k)
      }
    }
    return frames[frames.length - 1][1]
  }

  /** 뛰어올랐다 내려오는 높이(0~1). 정점이 40% 지점이라 올라갈 땐 빠르고 내려올 땐 느긋하다. */
  function arc(p) {
    const q = p < 0.4 ? (p / 0.4) * 0.5 : 0.5 + ((p - 0.4) / 0.6) * 0.5
    return Math.sin(Math.PI * q)
  }
  /** 착지 순간 눌렸다 펴지며 젤리처럼 두어 번 출렁이는 정도. 마지막 착지 이후 dt초. */
  // sin으로 시작해 0에서 출발한다: 착지 순간 값이 툭 바뀌지 않는다.
  const landing = dt => (dt >= 0 ? Math.exp(-dt / 0.12) * Math.sin(dt * 19) * 1.3 : 0)
  /** 부드럽게 0→1 로 차오르는 값(상태가 시작되자마자 툭 튀지 않게). */
  const ease = (t, s) => smooth(Math.min(1, Math.max(0, t / s)))

  // 상태별 몸(body) 움직임. t = 상태가 시작된 뒤 지난 초, u = 캐릭터 높이의 1%(px).
  const BODY = {
    // 가만히 있을 때: 세로로 늘었다(들숨) 눌렸다(날숨)를 한 번의 매끈한 파도로 오간다.
    // 예전엔 들숨 끝에 작은 반동을 넣었는데, 가만히 있을 때 혼자 움찔 튀는 것처럼 보여서 뺐다.
    idle: t => {
      const w = Math.sin((TAU * t) / 3.2) // -1 ~ 1, 3.2초 한 호흡
      return { ...ID, sx: 1 - 0.007 * w, sy: 1 + 0.016 * w }
    },
    talking: (t, u) => {
      const w = wave(t, 0.68)
      return { ...ID, ty: -0.9 * u * w, sx: 1 - 0.01 * w, sy: 1 + 0.017 * w }
    },
    happy: (t, u) => {
      const JUMP = 0.45
      const COUNT = 2
      const n = Math.floor(t / JUMP)
      if (n >= COUNT) {
        const sq = 0.08 * landing(t - COUNT * JUMP)
        return { ...ID, sx: 1 + sq * 0.6, sy: 1 - sq }
      }
      const p = (t % JUMP) / JUMP
      const h = arc(p)
      const land = n > 0 ? 0.08 * landing(t - n * JUMP) : 0
      // 뛰기 직전 살짝 웅크린다(0에서 시작해 0으로: 이음매 없음).
      // 두 번째부터는 착지 눌림이 곧 다음 도약의 웅크림이라 겹쳐 더하지 않는다.
      const crouch = n === 0 && p < 0.14 ? 0.06 * Math.sin((Math.PI * p) / 0.14) * Math.min(1, t / 0.04) : 0
      const air = 0.06 * h // 공중에선 세로로 쭉
      const sq = land + crouch - air
      return { ...ID, ty: -4.4 * u * h, sx: 1 + sq * 0.6, sy: 1 - sq }
    },
    // 부르르: 처음엔 크게, 점점 잦아든다.
    oops: (t, u) => {
      const DUR = 0.72
      if (t >= DUR) return ID
      const fade = 1 - t / DUR
      return { ...ID, tx: 1.2 * u * Math.sin((TAU * t) / 0.09) * fade, sy: 1 - 0.02 * fade * Math.min(1, t / 0.05), sx: 1 + 0.012 * fade * Math.min(1, t / 0.05) }
    },
    petted: t => {
      const [sx, sy] = keys((t % SQUISH_S) / SQUISH_S, [
        [0, [1, 1]],
        [0.28, [1.055, 0.92]],
        [0.58, [0.968, 1.036]],
        [0.8, [1.016, 0.982]],
        [1, [1, 1]],
      ])
      return { ...ID, sx, sy }
    },
    // 손을 뗀 직후: 말랑 주기가 끝난 (1, 1)에서 그대로 이어진다.
    // sin으로 시작하니 첫 프레임 값이 0이고, 쭉 펴지며 살짝 떴다가 감쇠 진동으로 가라앉는다.
    pleased: (t, u) => {
      const a = -0.06 * Math.exp(-t / 0.22) * Math.sin(t * 15)
      const lift = t < 0.32 ? -1.6 * u * Math.sin((Math.PI * t) / 0.32) : 0
      return { ...ID, ty: lift, sx: 1 + a * 0.7, sy: 1 - a }
    },
    dozing: t => {
      const b = 0.012 * wave(t, 5)
      return { ...ID, sx: 1 + b, sy: 1 - b }
    },
    sleeping: t => {
      const b = 0.012 * wave(t, 4)
      return { ...ID, sx: 1 + b, sy: 1 - b }
    },
    // 하품: 천천히 쭉 늘어나 부르르 떨다가, 스르르 내려앉는다.
    yawn: t => {
      const up = t < 0.9 ? smooth(t / 0.9) : t < 1.6 ? 1 : 1 - smooth(Math.min(1, (t - 1.6) / 0.8))
      const tremble = t > 0.9 && t < 1.6 ? 0.004 * Math.sin((t - 0.9) * 38) : 0
      const sag = t > 1.6 ? 0.014 * Math.sin(Math.PI * Math.min(1, (t - 1.6) / 0.8)) : 0
      return { ...ID, sx: 1 - 0.022 * up + sag * 0.6, sy: 1 + 0.045 * up + tremble - sag, rot: -2.5 * up }
    },
    // 기지개: 살짝 웅크렸다가 위로 쭉, 잠깐 버티고는 말랑하게 풀린다.
    stretch: t => {
      if (t < 0.14) {
        const k = Math.sin((Math.PI / 2) * (t / 0.14))
        return { ...ID, sx: 1 + 0.03 * k, sy: 1 - 0.05 * k }
      }
      if (t < 0.5) {
        const k = smooth((t - 0.14) / 0.36)
        return { ...ID, sx: 1.03 - 0.06 * k, sy: 0.95 + 0.11 * k }
      }
      if (t < 0.75) return { ...ID, sx: 0.97, sy: 1.06 + 0.005 * Math.sin((t - 0.5) * 40) }
      const d = t - 0.75
      const a = 0.06 * Math.exp(-d / 0.18) * Math.cos(d * 16)
      return { ...ID, sx: 1 - a * 0.5, sy: 1 + a }
    },
    // 깜짝: 쭉 늘어나며 퐁 뛰었다가 말랑하게 착지.
    surprised: (t, u) => {
      const UP = 0.32
      if (t < UP) {
        const p = t / UP
        const st = 0.07 * Math.sin(Math.PI * Math.min(1, p * 1.6))
        return { ...ID, ty: -2.6 * u * Math.sin(Math.PI * p), sx: 1 - st * 0.6, sy: 1 + st }
      }
      const sq = 0.075 * landing(t - UP)
      return { ...ID, sx: 1 + sq * 0.6, sy: 1 - sq }
    },
    // 갸웃: 고개를 이쪽저쪽으로 기울이며 기다린다(선택지를 보여 줄 때).
    asking: t => {
      const w = Math.sin((TAU * t) / 3.2)
      const tilt = 4.5 * w * (1.5 - 0.5 * w * w)
      const b = 0.01 * wave(t, 1.6)
      return { ...ID, rot: tilt * ease(t, 0.3), sx: 1 + b * 0.5, sy: 1 - b }
    },
    // 부끄: 몸을 배배 꼰다.
    shy: (t, u) => {
      const env = 0.6 + 0.4 * Math.exp(-t / 0.6)
      const w = Math.sin((TAU * t) / 0.46) * ease(t, 0.08)
      return { ...ID, rot: 3.2 * w * env, tx: 0.5 * u * w * env, sx: 1.012, sy: 0.98 + 0.008 * wave(t, 0.46) }
    },
    // 어질어질: 크게 휘청이다 점점 잦아든다.
    dizzy: (t, u) => {
      const env = Math.exp(-t / 1.1) * ease(t, 0.06)
      const w = Math.sin((TAU * t) / 0.85)
      return { ...ID, rot: (7 * w + 2 * Math.sin((TAU * t) / 1.7)) * env, tx: 1.2 * u * Math.sin((TAU * t) / 0.85 + 1) * env, sx: 1 + 0.01 * env * wave(t, 0.42), sy: 1 - 0.015 * env * wave(t, 0.42) }
    },
    // 반가워: 한 번 폴짝 뛰며 살랑.
    greet: (t, u) => {
      const PRE = 0.1
      const AIR = 0.42
      if (t < PRE) {
        const k = Math.sin((Math.PI / 2) * (t / PRE))
        return { ...ID, sx: 1 + 0.03 * k, sy: 1 - 0.05 * k }
      }
      const sway = 4 * Math.sin((TAU * (t - PRE)) / 0.7) * Math.exp(-(t - PRE) / 0.8)
      if (t < PRE + AIR) {
        const p = (t - PRE) / AIR
        const h = arc(p)
        const k = Math.cos((Math.PI / 2) * Math.min(1, p / 0.25)) // 웅크림이 풀리며 뛰어오른다
        return { ...ID, ty: -3.4 * u * h, sx: 1 + 0.03 * k - 0.03 * h, sy: 1 - 0.05 * k + 0.055 * h, rot: sway }
      }
      const sq = 0.08 * landing(t - PRE - AIR)
      return { ...ID, sx: 1 + sq * 0.6, sy: 1 - sq, rot: sway }
    },
    // 킥킥: 머리를 문지르면 간지러워서 작게 떤다.
    giggle: t => {
      const w = Math.sin((TAU * t) / 0.14) * ease(t, 0.05)
      return { ...ID, rot: 2.2 * w, sx: 1.01, sy: 0.988 - 0.01 * wave(t, 0.28) }
    },
  }

  // 상태별 작은 친구(buddy) 그림 움직임. 바깥 상자의 둥실거림도 이 엔진이 같이 그린다(float).
  // 여기서는 주인과 같은 박자로 말랑하게 눌리고 늘어나고 뛴다. 몸집이 작아서 주인보다 과장되게.
  /**
   * 통통 뛰기: 공중에선 세로로 살짝 늘어나고, 땅에 닿기 직전·직후엔 납작하게 눌린다.
   * 눌림은 착지 순간을 중심으로 앞뒤가 대칭이라 주기가 바뀌는 지점에서도 값이 이어진다.
   */
  function hop(t, u, period, height = 4, count = 0) {
    if (count && t >= period * count) {
      // 마지막 착지 뒤: 눌린 채로 멈추지 않고 착지 눌림이 자연스럽게 풀린다.
      const sq = 0.12 * Math.max(0, 1 - (t - period * count) / 0.07) ** 2
      return { ...ID, sx: 1 + sq * 0.8, sy: 1 - sq }
    }
    const p = (t % period) / period
    const h = arc(p)
    const d = Math.min(p, 1 - p) * period // 가장 가까운 착지까지 남은(지난) 초
    // 첫 도약은 0에서 눌리기 시작한다(상태가 바뀌자마자 납작해져 툭 튀지 않게).
    const ramp = t < period / 2 ? Math.min(1, t / 0.06) : 1
    const sq = 0.12 * ramp * Math.max(0, 1 - d / 0.07) ** 2
    const stretch = 0.06 * h
    return { ...ID, ty: -height * u * h, sx: 1 - stretch * 0.6 + sq * 0.8, sy: 1 + stretch - sq }
  }
  /** 제자리 말랑: 숨쉬듯 세로로 늘었다 눌렸다. 주인보다 반 박자 늦게(phase) 따라 한다. */
  function squishLoop(t, period, amp, phase = 0) {
    const w = Math.sin((TAU * (t / period + phase)))
    return { ...ID, sx: 1 - amp * 0.6 * w, sy: 1 + amp * w }
  }
  const BUDDY = {
    // 주인 호흡(3.2초)과 같은 박자로, 반 박자 늦게 말랑. 위아래로 뜨지는 않는다(혼자 튀어 보이지 않게).
    idle: t => squishLoop(t, 3.2, 0.035, -0.12),
    thinking: t => ({ ...squishLoop(t, 3.2, 0.025), rot: 6 * Math.sin((TAU * t) / 2.4) }),
    talking: (t, u) => hop(t, u, 0.36, 1.6),
    working: (t, u) => hop(t, u, 0.5, 4),
    happy: (t, u) => hop(t, u, 0.4, 5, 4),
    petted: (t, u) => hop(t, u, 0.28, 3.2), // 주인이 쓰다듬어지면 옆에서 신나서 콩콩
    pleased: (t, u) => hop(t, u, 0.42, 4.5, 1),
    oops: t => (t >= 0.9 ? ID : { ...ID, rot: -12 * wave(t, 0.3) }),
    dozing: t => squishLoop(t, 5, 0.03),
    sleeping: t => squishLoop(t, 4, 0.035),
    yawn: t => ({ ...squishLoop(t, 2.4, 0.03), rot: 5 * Math.sin((TAU * t) / 2.4) }),
    stretch: (t, u) => hop(t, u, 0.4, 3, 1),
    surprised: (t, u) => hop(t, u, 0.3, 6, 1),
    asking: t => ({ ...squishLoop(t, 1.6, 0.03), rot: -6 * Math.sin((TAU * t) / 3.2) }),
    shy: (t, u) => hop(t, u, 0.3, 2.5),
    dizzy: t => ({ ...ID, rot: 22 * Math.sin((TAU * t) / 0.6) * Math.exp(-t / 1.2) * ease(t, 0.06) }),
    greet: (t, u) => hop(t, u, 0.36, 5, 3),
    giggle: (t, u) => hop(t, u, 0.2, 1.8),
  }

  // 상태가 바뀌는 순간 몸이 한 번 "꿀렁": 눌렸다 늘어나며 새 상태로 들어간다. 값은 세기.
  const ENTRY = {
    idle: 0.022, thinking: 0.026, talking: 0.024, working: 0.03, happy: 0.045, oops: 0.04, sleeping: 0.014,
    yawn: 0.012, surprised: 0.05, asking: 0.03, shy: 0.03, dizzy: 0.035, greet: 0.04, giggle: 0.025,
  }
  /** 젤리 출렁임: 눌렸다 늘어났다를 두세 번 오가며 잦아든다. 부피가 그대로인 것처럼 가로는 반대로. */
  const jellyKick = (amp, decay = 0.2, freq = 16) => t => {
    const a = amp * Math.exp(-t / decay) * Math.sin(t * freq)
    return { ...ID, sx: 1 + a * 0.8, sy: 1 - a }
  }

  // 그릴 빠르기(초당 프레임). 배터리로 돌 때는 더 느리게.
  const FAST = new Set(['happy', 'petted', 'pleased', 'oops', 'surprised', 'stretch', 'shy', 'dizzy', 'greet', 'giggle'])
  const MID = new Set(['talking', 'working', 'thinking', 'asking', 'yawn'])
  // 보통 빠르기는 24: 생각 중 표시(1초에 12칸)가 두 프레임에 한 칸씩 딱 맞게 돈다.
  const FPS = { ac: { fast: 60, mid: 24, slow: 20 }, battery: { fast: 30, mid: 12, slow: 12 } }
  const now = () => performance.now()
  const mix = (a, b, k) => {
    const o = {}
    for (const key in ID) o[key] = a[key] + (b[key] - a[key]) * k
    return o
  }
  const isRest = v => Math.abs(v.tx) + Math.abs(v.ty) + Math.abs(v.sx - 1) + Math.abs(v.sy - 1) + Math.abs(v.rot) < 1e-4
  /** 기본 모양(ID)에서 벗어난 정도를 JUICE배로 키운다. */
  const juice = v => ({ tx: v.tx * JUICE, ty: v.ty * JUICE, sx: 1 + (v.sx - 1) * JUICE, sy: 1 + (v.sy - 1) * JUICE, rot: v.rot })
  const css = v =>
    isRest(v)
      ? ''
      : `translate(${v.tx.toFixed(2)}px, ${v.ty.toFixed(2)}px) rotate(${v.rot.toFixed(2)}deg) scale(${v.sx.toFixed(4)}, ${v.sy.toFixed(4)})`
  /**
   * 마지막으로 그린 모습에서 화면상 얼마나(px) 달라졌는가. size는 그림의 대략적인 높이(px).
   * 0.1px도 안 움직였으면 그리지 않는다: 숨쉬기의 꼭대기·바닥처럼 거의 멈춘 순간의 프레임을 아낀다.
   */
  const moved = (a, b, size) =>
    Math.max(Math.abs(a.tx - b.tx), Math.abs(a.ty - b.ty), Math.abs(a.sx - b.sx) * size, Math.abs(a.sy - b.sy) * size, (Math.abs(a.rot - b.rot) * Math.PI / 180) * size * 0.6)

  /** 한 요소의 움직임 트랙: 지금 상태의 움직임 + 바뀔 때 섞기 + 덧붙는 짧은 충격. */
  function track(node, table, size) {
    return { node, table, size, fn: null, start: now(), from: ID, blendStart: -Infinity, blendMs: BLEND_MS, last: ID, drawn: null, kicks: [] }
  }

  let tracks = []
  let mode = 'idle'
  let unit = 2
  let calm = false
  let paused = false
  let idleMotion = true
  let lowPower = false
  let raf = 0
  let timer = 0
  let lastFrame = 0
  let nextFrameAt = 0
  let scheduledFps = 0
  let frames = 0 // 실제로 그린 프레임 수(측정용)

  // 작은 친구의 바깥 상자: 늘 둥실둥실(3.4초 위아래, 5.3초 살랑). 예전엔 CSS 무한 애니메이션이었다.
  let float = null // { node, drawn }
  // 얼굴(눈·입·앞머리) 출렁임: 몸이 움직이면 얼굴이 살짝 늦게 따라오며 말랑하게 흔들린다(용수철).
  let face = null // { node, anchor, x, vx, y, vy, px, py, drawn }
  // 잠꼬대 z 세 개: 3.6초마다, 1.2초씩 어긋나게 떠오른다.
  let zs = [] // [{ node, drawn }]
  // 같은 루프에서 같이 그리는 작은 것들(생각 중 표시 등): fn(at)가 true를 돌려주는 동안 fps 이상으로 돈다.
  const tickers = new Map() // key → { fn, fps }

  function sample(tr, at) {
    const t = (at - tr.start) / 1000
    let v = tr.fn ? tr.fn(t, unit) : ID
    const k = (at - tr.blendStart) / tr.blendMs
    if (k < 1) v = mix(tr.from, v, easeOut(Math.max(0, k)))
    tr.kicks = tr.kicks.filter(kick => at - kick.start < kick.ms)
    for (const kick of tr.kicks) {
      const add = kick.fn((at - kick.start) / 1000, unit)
      v = { tx: v.tx + add.tx, ty: v.ty + add.ty, sx: v.sx * add.sx, sy: v.sy * add.sy, rot: v.rot + add.rot }
    }
    return v
  }

  /** 움직임이 끝났고(고정 상태 + 섞기 끝 + 충격 없음) 더 그릴 게 없는가. */
  function settled(tr, at) {
    if (tr.kicks.length || at - tr.blendStart < tr.blendMs) return false
    return !tr.fn || isRest(tr.fn((at - tr.start) / 1000, unit))
  }
  const excited = (tr, at) => tr.kicks.length > 0 || at - tr.blendStart < tr.blendMs

  function drawTrack(tr, at) {
    const v = sample(tr, at)
    tr.last = v
    const shown = juice(v)
    if (!tr.drawn || moved(shown, tr.drawn, tr.size()) >= 0.1 || (isRest(shown) && !isRest(tr.drawn))) {
      tr.node.style.transform = css(shown)
      tr.drawn = shown
      return true
    }
    return false
  }

  function drawFloat(at) {
    if (!float) return false
    const held = mode === 'held'
    if (calm || held) return false
    const t = at / 1000
    const y = unit * (1.3 - 3 * smooth(tri(t, 3.4)))
    const r = -2.2 + 4.4 * smooth(tri(t, 5.3))
    if (float.drawn && Math.abs(float.drawn.y - y) < 0.08 && Math.abs(float.drawn.r - r) < 0.05) return true
    float.node.style.translate = `0 ${y.toFixed(2)}px`
    float.node.style.rotate = `${r.toFixed(2)}deg`
    float.drawn = { y, r }
    return true
  }
  /** 0→1→0 삼각파(한 방향이 period초). CSS alternate 와 같다. */
  function tri(t, period) {
    const p = (t / period) % 2
    return p < 1 ? p : 2 - p
  }

  /** 얼굴 용수철을 한 프레임 진행한다. 몸에서 얼굴 높이(anchor)가 움직인 만큼을 늦게 따라간다. */
  function stepFace(at, dt) {
    if (!face || !tracks[0]) return false
    const v = juice(tracks[0].last)
    // 몸 아래쪽 가운데를 축으로 늘고 줄고 기울므로, 얼굴 높이에서는 그만큼 위아래·옆으로 움직인다.
    const h = face.anchor
    const py = v.ty - (v.sy - 1) * h
    const px = v.tx + Math.sin((v.rot * Math.PI) / 180) * h
    if (face.py === null) { face.py = py; face.px = px; face.y = py; face.x = px }
    // 몸(얼굴 자리)이 움직이는 빠르기: 얼굴이 몸과 같이 움직이는 건 출렁임이 아니다.
    const pvy = dt > 0 ? (py - face.py) / dt : 0
    const pvx = dt > 0 ? (px - face.px) / dt : 0
    face.py = py
    face.px = px
    const W = TAU * 4.2 // 1초에 4번 남짓 출렁인다
    const Z = 0.3 // 작을수록 오래 출렁인다
    let left = Math.min(dt, 0.1)
    while (left > 0) {
      const s = Math.min(left, 1 / 120)
      face.vy += (W * W * (py - face.y) - 2 * Z * W * face.vy) * s
      face.vx += (W * W * (px - face.x) - 2 * Z * W * face.vx) * s
      face.y += face.vy * s
      face.x += face.vx * s
      left -= s
    }
    const max = unit * 1.1
    const dy = Math.max(-max, Math.min(max, face.y - py))
    const dx = Math.max(-max, Math.min(max, face.x - px))
    const busy = Math.abs(dy) > 0.06 || Math.abs(dx) > 0.06 || Math.abs(face.vy - pvy) > 3 || Math.abs(face.vx - pvx) > 3
    const squish = Math.max(-0.06, Math.min(0.06, dy / (unit * 9)))
    const shown = { x: busy ? dx : 0, y: busy ? dy : 0, s: busy ? squish : 0 }
    if (!face.drawn || Math.abs(shown.x - face.drawn.x) + Math.abs(shown.y - face.drawn.y) >= 0.08 || Math.abs(shown.s - face.drawn.s) * h >= 0.08) {
      face.node.style.transform = shown.x || shown.y || shown.s
        ? `translate(${shown.x.toFixed(2)}px, ${shown.y.toFixed(2)}px) scale(${(1 + shown.s * 0.5).toFixed(4)}, ${(1 - shown.s).toFixed(4)})`
        : ''
      face.drawn = shown
    }
    return busy
  }
  function resetFace() {
    if (!face) return
    face.py = null
    face.vx = face.vy = 0
    face.node.style.transform = ''
    face.drawn = null
  }

  function drawZs(at) {
    if (!zs.length) return false
    const on = mode === 'sleeping' && !calm
    if (!on) {
      for (const z of zs) if (z.drawn !== null) { z.node.style.opacity = ''; z.node.style.translate = ''; z.drawn = null }
      return false
    }
    const t = at / 1000
    zs.forEach((z, i) => {
      const p = (((t - i * 1.2) % 3.6) + 3.6) % 3.6 / 3.6
      const opacity = p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85
      const e = 1 - (1 - p) ** 2
      const key = `${opacity.toFixed(2)}/${(e * 8 * unit).toFixed(1)}`
      if (key === z.drawn) return
      z.node.style.opacity = opacity.toFixed(2)
      z.node.style.translate = `${(e * 8 * unit).toFixed(1)}px ${(-e * 16 * unit).toFixed(1)}px`
      z.drawn = key
    })
    return true
  }

  function fpsFor(at, faceBusy) {
    const tier = lowPower ? FPS.battery : FPS.ac
    if (tracks.some(tr => excited(tr, at)) || FAST.has(mode)) return tier.fast
    // 얼굴 출렁임은 용수철을 잘게 나눠 계산하므로 1초에 30번만 그려도 매끈하다.
    if (faceBusy || MID.has(mode)) return tier.mid
    return tier.slow
  }

  function frame() {
    raf = 0
    if (paused) return
    // Use the same clock as setMode(), kicks and timeout deadlines. Chromium's
    // rAF timestamp can describe an earlier vsync, several ms behind now().
    const at = now()
    const dt = lastFrame ? (at - lastFrame) / 1000 : 1 / 60
    lastFrame = at
    let busy = false
    let drew = false
    let faceBusy = false
    // 움직임 줄이기: 몸은 그대로 두고, 걸어 둔 작은 것(생각 중 표시)만 돌린다.
    if (!calm) {
      for (const tr of tracks) {
        if (drawTrack(tr, at)) drew = true
        if (!settled(tr, at)) busy = true
      }
      faceBusy = stepFace(at, dt)
      if (faceBusy) busy = true
      if (drawFloat(at)) busy = true
      if (drawZs(at)) busy = true
    }
    let tickFps = 0
    for (const [key, t] of tickers) {
      if (t.fn(at)) { busy = true; tickFps = Math.max(tickFps, t.fps) } else tickers.delete(key)
    }
    if (drew) frames++
    if (busy && !paused) schedule(calm ? tickFps : Math.max(tickFps, fpsFor(at, faceBusy)))
    else lastFrame = 0
  }
  /** 다음 프레임: 빠른 움직임은 화면 주기에 맞춰, 느린 움직임은 잠깐 쉬었다가 다음 화면 주기에. */
  function schedule(fps) {
    if (fps >= 55) {
      nextFrameAt = 0
      scheduledFps = fps
      raf = requestAnimationFrame(frame)
      return
    }
    const interval = 1000 / fps
    // Carry the target deadline forward. Starting a fresh shortened timeout at
    // every refresh made the nominal 24fps tier draw at 30fps on 60Hz screens.
    nextFrameAt = scheduledFps === fps && nextFrameAt
      ? Math.max(nextFrameAt + interval, now() + interval / 2)
      : now() + interval
    scheduledFps = fps
    // Sleep until the deadline itself: waking early then waiting through rAFs
    // defeats the power cap, especially with stale compositor timestamps.
    timer = setTimeout(() => { timer = 0; raf = requestAnimationFrame(frame) }, Math.max(0, nextFrameAt - now()))
  }
  /** 바로 그리기 시작한다. 느린 주기로 쉬는 중이면 깨운다(폴짝·말랑이 늦게 시작하지 않게). */
  const wakeLoop = () => {
    if ((calm && !tickers.size) || paused) return
    if (timer) { clearTimeout(timer); timer = 0 }
    nextFrameAt = 0
    if (!raf) raf = requestAnimationFrame(frame)
  }
  const stopLoop = () => {
    if (raf) cancelAnimationFrame(raf)
    if (timer) clearTimeout(timer)
    raf = timer = 0
    lastFrame = nextFrameAt = scheduledFps = 0
  }

  return {
    /** 가만히 있을 때 숨쉬기를 켜고 끈다(배터리 모드). 끄면 지금 모습에서 부드럽게 멈춘다. */
    setIdleMotion(on) {
      if (idleMotion === !!on) return
      idleMotion = !!on
      if (mode === 'idle') this.setMode('idle', true)
    },
    /** 배터리로 돌 때: 같은 움직임을 조금 덜 자주 그린다(빠른 30, 보통·느린 12프레임). */
    setLowPower(on) {
      lowPower = !!on
    },
    /** 창이 숨겨지면 루프를 멈추고, 다시 보이면 지금 상태에서 이어 간다(백그라운드 전력 절약). */
    setPaused(on) {
      paused = !!on
      if (paused) stopLoop()
      else wakeLoop()
    },
    /**
     * body, buddy 그림 요소를 등록한다. buddy가 없으면 null.
     * extra: { float: 작은 친구 바깥 상자, face: 얼굴 묶음, zs: 잠꼬대 z 요소들 }
     */
    attach(bodyNode, buddyNode, extra = {}) {
      tracks = [track(bodyNode, BODY, () => unit * 100)]
      if (buddyNode) tracks.push(track(buddyNode, BUDDY, () => unit * 22))
      float = extra.float ? { node: extra.float, drawn: null } : null
      face = extra.face ? { node: extra.face, anchor: unit * 70, x: 0, vx: 0, y: 0, vy: 0, px: 0, py: null, drawn: null } : null
      zs = (extra.zs || []).map(node => ({ node, drawn: null }))
      this.setMode(mode, true) // 등록 전에 바뀐 상태도 반영
    },
    setUnit(px) {
      unit = px
    },
    /** 몸 아래 끝에서 얼굴(눈 가운데)까지의 높이(px). 얼굴 출렁임의 지렛대 길이. */
    setFaceAnchor(px) {
      if (face && Number.isFinite(px) && px > 0) face.anchor = px
    },
    setCalm(on) {
      if (calm === !!on) return
      calm = !!on
      if (calm) {
        stopLoop()
        for (const tr of tracks) { tr.node.style.transform = ''; tr.drawn = null }
        if (float) { float.node.style.translate = ''; float.node.style.rotate = ''; float.drawn = null }
        resetFace()
        drawZs(now())
        // Reduced motion stops body movement; an active status spinner still
        // needs its shared ticker after stopLoop() cancelled the pending frame.
        wakeLoop()
      } else this.setMode(mode, true)
    },
    setMode(next, force = false) {
      if (next === mode && !force) return
      mode = next
      const at = now()
      for (const tr of tracks) {
        // 지금 화면에 보이는 모습에서 출발해야 툭 튀지 않는다.
        tr.from = tr.last
        tr.blendStart = at
        tr.blendMs = BLEND_MS
        tr.start = at
        // 배터리로 돌 때는 가만히 있는 동안의 숨쉬기를 쉰다(매 프레임 그리기를 멈춰 전력 절약).
        tr.fn = mode === 'idle' && !idleMotion ? null : tr.table[mode] ?? null
      }
      if (!force && ENTRY[mode]) {
        // 상태가 바뀔 때 주인과 작은 친구가 같이 꿀렁. 작은 친구는 1.8배 과장.
        tracks.forEach((tr, i) => tr.kicks.push({ fn: jellyKick(ENTRY[mode] * (i ? 1.8 : 1)), ms: 520, start: at }))
      }
      wakeLoop()
    },
    /** 쓰다듬기 말랑 주기가 끝나 (1, 1)로 돌아올 때까지 남은 ms. 다른 상태면 0. */
    untilSquishEnd() {
      const tr = tracks[0]
      if (calm || !tr || mode !== 'petted') return 0
      const t = (now() - tr.start) / 1000
      return Math.round((SQUISH_S - (t % SQUISH_S)) * 1000)
    },
    /**
     * 연타: 칠 때마다 지금 동작을 처음(0초)부터 다시 시작한다.
     * 아주 짧게(RESTART_BLEND_MS) 이어 붙여서, 처음으로 돌아가되 한 프레임에 툭 끊기지는 않는다.
     */
    restart() {
      if (calm) return
      const RESTART_BLEND_MS = 45
      const at = now()
      for (const tr of tracks) {
        tr.from = tr.last
        tr.blendStart = at
        tr.blendMs = RESTART_BLEND_MS
        tr.start = at
        tr.kicks = []
      }
      // 맞는 순간 꾹: 위에서 누른 듯 납작해졌다 튕겨 오른다(젤리처럼 두어 번 출렁).
      tracks[0]?.kicks.push({ fn: jellyKick(0.04, 0.1, 24), ms: 380, start: at })
      wakeLoop()
    },
    /** 지금 동작 위에 말랑한 출렁임을 한 번 얹는다(말풍선이 열릴 때, 내려놓을 때 등). */
    bounce(amp = 0.03) {
      if (calm || !tracks[0]) return
      tracks[0].kicks.push({ fn: jellyKick(amp, 0.22, 15), ms: 700, start: now() })
      if (tracks[1]) tracks[1].kicks.push({ fn: jellyKick(amp * 1.6, 0.18, 17), ms: 600, start: now() })
      wakeLoop()
    },
    /** 지금 움직임 위에 짧은 충격을 얹는다(예: 깜빡일 때 몸이 살짝 출렁). */
    kick(fn, ms) {
      if (calm || !tracks[0]) return
      tracks[0].kicks.push({ fn, ms, start: now() })
      wakeLoop()
    },
    /**
     * 몸짓과 같은 프레임에 같이 그릴 것을 건다(따로 타이머를 돌리면 화면을 그만큼 더 자주 다시 그린다).
     * fn(at)가 false를 돌려주면 내려간다. 같은 key로 다시 걸면 바꾼다.
     */
    tick(key, fn, fps = 12) {
      if (fn) tickers.set(key, { fn, fps })
      else tickers.delete(key)
      wakeLoop()
    },
    /** 측정용: 지금까지 실제로 그린 프레임 수와 지금 상태. */
    stats() {
      return { frames, mode, lowPower, running: !!(raf || timer) }
    },
    ID,
  }
})()
  if (typeof module !== 'undefined' && module.exports) module.exports = PetAnimator
  else root.PetAnimator = PetAnimator
})(typeof window === 'undefined' ? globalThis : window)
