import {
    type FoodId,
    type Hedgehog,
    type Outcome,
    type StatTuple,
    ROSTER,
    chonkStage,
    hogiversariesOn,
    levelForXp,
    utcDay,
} from '../shared/game'
import { audio } from './audio'
import { chatterFor, OUTCOME_LINES, pick } from './lines'
import * as S from './sprites'

export const WORLD_W = 1216
export const WORLD_H = 832
const FENCE = 14
const INTERACT_RANGE = 26
/** hang around this close to a hedgehog for LINGER_MS and their picture pops up */
const LINGER_RANGE = 52
const LINGER_MS = 2000

type Ellipse = { cx: number; cy: number; rx: number; ry: number }
type Rect = { x: number; y: number; w: number; h: number }
export type PropAction = 'ranks' | 'farmer' | 'help' | 'pond'
type Prop = { x: number; y: number; sprite: S.Sprite; solid?: Rect; action?: PropAction; label?: string }

type Particle = {
    x: number
    y: number
    vx: number
    vy: number
    life: number
    max: number
    kind: 'pixel' | 'sprite' | 'text' | 'firefly'
    color?: string
    sprite?: S.Sprite
    text?: string
    gravity?: number
}

function mulberry32(seed: number) {
    return () => {
        seed |= 0
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by)
const isTouch = matchMedia('(pointer: coarse)').matches

/** 0 = day, ~0.5 = deep night, from the visitor's local clock */
function darkness(): number {
    const d = new Date()
    const h = d.getHours() + d.getMinutes() / 60
    if (h >= 21 || h < 5) return 0.5
    if (h >= 19) return ((h - 19) / 2) * 0.5
    if (h < 7) return ((7 - h) / 2) * 0.5
    return 0
}

// ---------------------------------------------------------------- hedgehogs

export class Hog {
    x: number
    y: number
    homeX: number
    homeY: number
    tx: number
    ty: number
    state: 'idle' | 'walk' | 'sleep' = 'idle'
    timer = Math.random() * 3
    facing: 1 | -1 = Math.random() < 0.5 ? 1 : -1
    anim = Math.random() * 10
    stats: StatTuple = [0, 0, null]
    stage = 0
    level = 1
    eatUntil = 0
    eatingFood: FoodId | null = null
    hopUntil = 0
    zoomUntil = 0
    whistled = false
    bubble: { text: string; until: number } | null = null
    /** when the farmer came within LINGER_RANGE (0 = not near) */
    nearSince = 0
    zTimer = 0

    constructor(
        public h: Hedgehog,
        x: number,
        y: number
    ) {
        this.x = this.homeX = this.tx = x
        this.y = this.homeY = this.ty = y
    }

    setStats(stats: StatTuple | undefined) {
        this.stats = stats ?? [0, 0, null]
        this.level = levelForXp(this.stats[0])
        this.stage = chonkStage(this.level)
    }

    say(text: string, seconds = 4) {
        this.bubble = { text, until: performance.now() + seconds * 1000 }
    }

    get sprite(): S.Sprite {
        const now = performance.now()
        let frame: S.HogFrame = 'walk0'
        if (now < this.eatUntil) frame = Math.floor(now / 140) % 2 ? 'eat' : 'walk0'
        else if (this.state === 'sleep') frame = 'sleep'
        else if (this.state === 'walk' || this.whistled) frame = Math.floor(this.anim / (this.zooming ? 0.07 : 0.18)) % 2 ? 'walk1' : 'walk0'
        return S.hedgehogSprite(this.h.color, this.stage, frame)
    }

    get zooming() {
        return performance.now() < this.zoomUntil
    }
}

// ---------------------------------------------------------------- world

export class World {
    ctx: CanvasRenderingContext2D
    terrain!: S.Sprite
    props: Prop[] = []
    ponds: Ellipse[] = []
    solids: Rect[] = []
    hogs: Hog[] = []
    hogById = new Map<number, Hog>()
    particles: Particle[] = []
    player = { x: 0, y: 0, dir: 'down' as S.FarmerDir, flip: false, moving: false, anim: 0, visible: false }
    moveTarget: { x: number; y: number; hog?: Hog; prop?: Prop } | null = null
    stuckTime = 0
    cam = { x: WORLD_W / 2, y: WORLD_H / 2 }
    pixelScale = 3
    /** device pixels per world pixel before the farmer's own zoom */
    private basePixelScale = 3
    /** how many device-pixel steps the farmer zoomed in (+) or out (-) */
    private zoomSteps = 0
    private wheelAccum = 0
    private lastWheelStep = 0
    private wheelReset = 0
    private touches = new Map<number, { x: number; y: number }>()
    private pinchDist = 0
    dpr = 1
    viewW = 0
    viewH = 0
    keys = new Set<string>()
    pointer: { x: number; y: number } | null = null
    hovered: Hog | null = null
    hoveredProp: Prop | null = null
    nearbyHog: Hog | null = null
    nearbyProp: Prop | null = null
    mode: 'title' | 'play' = 'title'
    paused = false
    showNames = false
    /** hedgehogs celebrating their PostHog anniversary today: party hats + 1.5x XP */
    partyIds = new Set<number>()
    day = utcDay()
    highlightId: number | null = null
    /** point the compass at the nearest party hog when nothing else is being tracked */
    partyCompass = false
    nextChatter = 0
    darkness = darkness()
    titleAngle = 0
    lastTime = performance.now()

    onHog: (hog: Hog) => void = () => {}
    onProp: (action: PropAction) => void = () => {}
    onMeet: (hog: Hog) => void = () => {}

    constructor(public canvas: HTMLCanvasElement) {
        this.ctx = canvas.getContext('2d')!
        this.generate()
        this.resize()
        addEventListener('resize', () => this.resize())
        this.bindInput()
        setInterval(() => (this.darkness = darkness()), 60_000)
    }

    // ------------------------------------------------------------ generation

    private generate() {
        const rand = mulberry32(20200124) // PostHog's first commit-ish. Same farm for everyone.
        const barnX = WORLD_W / 2
        const barnY = 168
        const crops: Rect = { x: barnX - 230, y: 88, w: 140, h: 76 }
        this.ponds = [
            { cx: WORLD_W * 0.8, cy: WORLD_H * 0.7, rx: 112, ry: 64 },
            { cx: WORLD_W * 0.16, cy: WORLD_H * 0.36, rx: 58, ry: 36 },
        ]
        const hPathY = (x: number) => 452 + Math.sin(x / 70) * 12
        const vPathX = (y: number) => barnX + Math.sin(y / 55) * 7
        const onPath = (x: number, y: number, pad = 0) =>
            Math.abs(y - hPathY(x)) < 11 + pad || (y > barnY - 4 && Math.abs(x - vPathX(y)) < 10 + pad)
        const inPond = (x: number, y: number, pad = 1) =>
            this.ponds.some((p) => ((x - p.cx) / (p.rx * pad)) ** 2 + ((y - p.cy) / (p.ry * pad)) ** 2 <= 1)
        const inRect = (x: number, y: number, r: Rect, pad = 0) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad

        // terrain pixels
        const t = S.makeCanvas(WORLD_W, WORLD_H)
        const tctx = t.getContext('2d')!
        const img = tctx.createImageData(WORLD_W, WORLD_H)
        const d = img.data
        const grass = ['#5DAE48', '#62B44D', '#58A644'].map(S.hexToRgb)
        const set = (i: number, c: [number, number, number]) => {
            d[i] = c[0]
            d[i + 1] = c[1]
            d[i + 2] = c[2]
            d[i + 3] = 255
        }
        const C = Object.fromEntries(
            Object.entries({
                dark: '#3E7F32',
                dark2: '#36722B',
                blade: '#4C9A3A',
                bladeLight: '#7CCB5E',
                dirt: '#C8A165',
                dirtDark: '#B08850',
                dirtLight: '#D9B77E',
                dirtEdge: '#A88350',
                water: '#4BA3D9',
                waterDeep: '#3B8FC7',
                waterLight: '#8FD3F5',
                waterEdge: '#2B6F99',
                sand: '#E2C98A',
                soil: '#7A4E2D',
                furrow: '#5E3A20',
                sprout: '#6CC070',
            }).map(([k, v]) => [k, S.hexToRgb(v)])
        ) as Record<string, [number, number, number]>

        for (let y = 0; y < WORLD_H; y++) {
            for (let x = 0; x < WORLD_W; x++) {
                const i = (y * WORLD_W + x) * 4
                const r = rand()
                if (x < FENCE || y < FENCE || x >= WORLD_W - FENCE || y >= WORLD_H - FENCE) {
                    set(i, r < 0.15 ? C.dark2 : C.dark)
                    continue
                }
                const pond = this.ponds.find((p) => ((x - p.cx) / (p.rx * 1.14)) ** 2 + ((y - p.cy) / (p.ry * 1.14)) ** 2 <= 1)
                if (pond) {
                    const pd = ((x - pond.cx) / pond.rx) ** 2 + ((y - pond.cy) / pond.ry) ** 2
                    if (pd > 1.0) set(i, r < 0.1 ? C.dirtLight : C.sand)
                    else if (pd > 0.9) set(i, C.waterEdge)
                    else if ((y + Math.floor(x / 12)) % 9 === 0 && (x + y) % 5 < 3 && pd < 0.75) set(i, C.waterLight)
                    else set(i, pd < 0.4 ? C.waterDeep : C.water)
                    continue
                }
                if (inRect(x, y, crops)) {
                    const row = (y - crops.y) % 8
                    if (row < 2) set(i, C.furrow)
                    else if (row === 2 && (x - crops.x) % 6 < 2 && x - crops.x > 2 && crops.x + crops.w - x > 2) set(i, C.sprout)
                    else if (row === 3 && (x - crops.x) % 6 === 0 && x - crops.x > 2) set(i, C.sprout)
                    else set(i, r < 0.1 ? C.furrow : C.soil)
                    continue
                }
                if (onPath(x, y)) {
                    const edge = !onPath(x, y, -1.5)
                    set(i, edge ? C.dirtEdge : r < 0.08 ? C.dirtDark : r < 0.14 ? C.dirtLight : C.dirt)
                    continue
                }
                const tile = grass[(Math.floor(x / 16) * 7 + Math.floor(y / 16) * 13) % 3]
                set(i, r < 0.05 ? C.blade : r < 0.075 ? C.bladeLight : tile)
            }
        }
        tctx.putImageData(img, 0, 0)

        // grass tufts and flowers
        const flowerColors = ['#FF5C8A', '#FFE066', '#FFFFFF', '#9FC4FF', '#E8A2FF', '#FF9F43']
        for (let n = 0; n < 420; n++) {
            const x = FENCE + rand() * (WORLD_W - FENCE * 2)
            const y = FENCE + rand() * (WORLD_H - FENCE * 2)
            if (onPath(x, y, 3) || inPond(x, y, 1.2) || inRect(x, y, crops, 4)) continue
            if (rand() < 0.5) {
                tctx.fillStyle = '#4C9A3A'
                tctx.fillRect(Math.round(x), Math.round(y), 1, 2)
                tctx.fillRect(Math.round(x) + 2, Math.round(y) - 1, 1, 3)
                tctx.fillRect(Math.round(x) + 4, Math.round(y), 1, 2)
            } else {
                const col = flowerColors[Math.floor(rand() * flowerColors.length)]
                for (let k = 0; k < 3 + rand() * 4; k++) {
                    const fx = Math.round(x + (rand() - 0.5) * 10)
                    const fy = Math.round(y + (rand() - 0.5) * 8)
                    tctx.fillStyle = col
                    tctx.fillRect(fx - 1, fy, 3, 1)
                    tctx.fillRect(fx, fy - 1, 1, 3)
                    tctx.fillStyle = '#F7A501'
                    tctx.fillRect(fx, fy, 1, 1)
                }
            }
        }
        // lily pads
        for (const p of this.ponds) {
            for (let n = 0; n < p.rx / 10; n++) {
                const a = rand() * Math.PI * 2
                const r = 0.3 + rand() * 0.5
                const lx = Math.round(p.cx + Math.cos(a) * p.rx * r)
                const ly = Math.round(p.cy + Math.sin(a) * p.ry * r)
                tctx.fillStyle = '#2E7D32'
                tctx.fillRect(lx - 3, ly - 1, 7, 3)
                tctx.fillRect(lx - 2, ly - 2, 5, 5)
                tctx.fillStyle = '#4CAF50'
                tctx.fillRect(lx - 2, ly - 1, 4, 2)
                if (rand() < 0.4) {
                    tctx.fillStyle = '#FF9EC4'
                    tctx.fillRect(lx, ly - 2, 2, 2)
                }
            }
        }
        // fence
        tctx.fillStyle = '#2a1a12'
        tctx.fillRect(FENCE - 4, FENCE - 4, WORLD_W - FENCE * 2 + 8, 4)
        tctx.fillRect(FENCE - 4, WORLD_H - FENCE, WORLD_W - FENCE * 2 + 8, 4)
        tctx.fillRect(FENCE - 4, FENCE - 4, 4, WORLD_H - FENCE * 2 + 8)
        tctx.fillRect(WORLD_W - FENCE, FENCE - 4, 4, WORLD_H - FENCE * 2 + 8)
        tctx.fillStyle = '#B5844C'
        tctx.fillRect(FENCE - 3, FENCE - 3, WORLD_W - FENCE * 2 + 6, 2)
        tctx.fillRect(FENCE - 3, WORLD_H - FENCE + 1, WORLD_W - FENCE * 2 + 6, 2)
        tctx.fillRect(FENCE - 3, FENCE - 3, 2, WORLD_H - FENCE * 2 + 6)
        tctx.fillRect(WORLD_W - FENCE + 1, FENCE - 3, 2, WORLD_H - FENCE * 2 + 6)
        for (let x = FENCE - 4; x < WORLD_W - FENCE + 4; x += 24) {
            for (const y of [FENCE - 6, WORLD_H - FENCE - 2]) {
                tctx.fillStyle = '#2a1a12'
                tctx.fillRect(x, y, 4, 8)
                tctx.fillStyle = '#8B5E34'
                tctx.fillRect(x + 1, y + 1, 2, 6)
            }
        }
        for (let y = FENCE - 4; y < WORLD_H - FENCE + 4; y += 24) {
            for (const x of [FENCE - 6, WORLD_W - FENCE - 2]) {
                tctx.fillStyle = '#2a1a12'
                tctx.fillRect(x, y, 8, 4)
                tctx.fillStyle = '#8B5E34'
                tctx.fillRect(x + 1, y + 1, 6, 2)
            }
        }
        this.terrain = t

        // props
        const barn = S.barnSprite()
        this.props.push({
            x: barnX,
            y: barnY,
            sprite: barn,
            solid: { x: barnX - 26, y: barnY - 34, w: 52, h: 32 },
            action: 'farmer',
            label: 'BARN: YOUR FARMER STATS',
        })
        this.props.push({
            x: barnX + 58,
            y: barnY + 26,
            sprite: S.boardSprite(),
            solid: { x: barnX + 50, y: barnY + 21, w: 16, h: 5 },
            action: 'ranks',
            label: 'NOTICEBOARD: RANKINGS',
        })
        this.props.push({
            x: barnX - 46,
            y: barnY + 30,
            sprite: S.signSprite(),
            solid: { x: barnX - 48, y: barnY + 26, w: 4, h: 4 },
            action: 'help',
            label: 'SIGN: HOW TO PLAY',
        })
        const barnZone: Rect = { x: barnX - 90, y: 60, w: 180, h: 160 }
        const occupied: { x: number; y: number; r: number }[] = []
        const free = (x: number, y: number, r: number) =>
            !onPath(x, y, r) &&
            !inPond(x, y, 1.25) &&
            !inRect(x, y, crops, r) &&
            !inRect(x, y, barnZone) &&
            occupied.every((o) => dist(o.x, o.y, x, y) > o.r + r)
        for (let n = 0; n < 220 && occupied.length < 70; n++) {
            const x = 30 + rand() * (WORLD_W - 60)
            const y = 40 + rand() * (WORLD_H - 60)
            if (!free(x, y, 16)) continue
            occupied.push({ x, y, r: 16 })
            this.props.push({ x, y, sprite: S.treeSprite(Math.floor(rand() * 4)), solid: { x: x - 3, y: y - 5, w: 6, h: 4 } })
        }
        const rock = S.rockSprite()
        const bush = S.bushSprite()
        for (let n = 0; n < 200 && occupied.length < 130; n++) {
            const x = 30 + rand() * (WORLD_W - 60)
            const y = 30 + rand() * (WORLD_H - 50)
            if (!free(x, y, 8)) continue
            occupied.push({ x, y, r: 8 })
            const isRock = rand() < 0.4
            this.props.push({ x, y, sprite: isRock ? rock : bush, solid: isRock ? { x: x - 3, y: y - 3, w: 6, h: 3 } : undefined })
        }
        this.solids = this.props.filter((p) => p.solid).map((p) => p.solid!)

        // hedgehogs
        for (const h of ROSTER) {
            let x = 0
            let y = 0
            for (let tries = 0; tries < 200; tries++) {
                x = 40 + rand() * (WORLD_W - 80)
                y = 50 + rand() * (WORLD_H - 90)
                if (!this.isSolid(x, y, 6) && !inRect(x, y, barnZone) && !inRect(x, y, crops)) break
            }
            const hog = new Hog(h, x, y)
            this.hogs.push(hog)
            this.hogById.set(h.id, hog)
        }

        this.player.x = barnX
        this.player.y = barnY + 22
    }

    isSolid(x: number, y: number, pad = 0): boolean {
        if (x < FENCE + 4 + pad || y < FENCE + 8 + pad || x > WORLD_W - FENCE - 4 - pad || y > WORLD_H - FENCE - 2 - pad) return true
        if (this.ponds.some((p) => ((x - p.cx) / (p.rx + pad)) ** 2 + ((y - p.cy) / (p.ry + pad)) ** 2 <= 1)) return true
        return this.solids.some((r) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad)
    }

    // ------------------------------------------------------------ public API

    applyStats(stats: Record<number, StatTuple>, day: string) {
        this.day = day
        this.partyIds = new Set(hogiversariesOn(day).map((h) => h.id))
        for (const hog of this.hogs) hog.setStats(stats[hog.h.id])
    }

    startPlaying() {
        this.mode = 'play'
        this.player.visible = true
        this.cam.x = this.player.x
        this.cam.y = this.player.y
    }

    whistle(hog: Hog) {
        audio.play('whistle')
        hog.whistled = true
        hog.state = 'walk'
        hog.say('!!!', 1.5)
        this.highlightId = hog.h.id
    }

    /** Big local celebration after *you* fed someone */
    celebrate(hog: Hog, food: FoodId, outcome: Outcome, xp: number, leveledUp: boolean) {
        const now = performance.now()
        hog.eatUntil = now + 2200
        hog.eatingFood = food
        hog.state = 'idle'
        hog.timer = 3
        hog.facing = this.player.x < hog.x ? -1 : 1
        this.particles.push({
            x: hog.x + hog.facing * 8,
            y: hog.y - 30,
            vx: 0,
            vy: 0,
            gravity: 120,
            life: 0.6,
            max: 0.6,
            kind: 'sprite',
            sprite: S.foodSprite(food),
        })
        setTimeout(() => {
            audio.play('nom')
            this.burst(hog.x + hog.facing * 8, hog.y - 4, ['#E6B566', '#B07A2E', '#fff'], 14)
        }, 500)
        setTimeout(() => {
            hog.hopUntil = performance.now() + 1500
            if (outcome === 'mystery_sock') this.particles.push({ x: hog.x, y: hog.y - 20, vx: 0, vy: -10, life: 2, max: 2, kind: 'sprite', sprite: S.SOCK })
            if (xp > 0) this.hearts(hog, 6)
            this.floatText(hog.x, hog.y - 26, xp > 0 ? `+${xp} XP` : '+0 XP', xp > 0 ? '#FFE066' : '#ccc')
            hog.say(pick(OUTCOME_LINES[outcome]), 5)
            if (outcome === 'zoomies') hog.zoomUntil = performance.now() + 30_000
            if (leveledUp) {
                audio.play('levelup')
                this.floatText(hog.x, hog.y - 40, `LEVEL ${hog.level}!`, '#9FF0FF', 2.5)
                this.burst(hog.x, hog.y - 10, ['#FFE066', '#FFFFFF', '#9FF0FF', '#FF9EC4'], 40, 90)
            }
        }, 2200)
    }

    /** Someone else fed this hedgehog */
    remoteFeed(hog: Hog) {
        hog.eatUntil = performance.now() + 1500
        hog.hopUntil = performance.now() + 1500
        if (this.onScreen(hog.x, hog.y)) {
            this.hearts(hog, 3)
            hog.say(pick(['Nom! Thanks, stranger!', '*munch*', 'A gift from afar!', 'Snack delivery!']), 3)
        }
    }

    nearestPartyHog(): Hog | undefined {
        let best: Hog | undefined
        let bestD = Infinity
        for (const id of this.partyIds) {
            const hog = this.hogById.get(id)
            const d = hog ? dist(hog.x, hog.y, this.player.x, this.player.y) : Infinity
            if (d < bestD) [best, bestD] = [hog, d]
        }
        return best
    }

    /** Forget whoever we were tracking or whistling for (e.g. once we've met someone) */
    stopTracking() {
        this.highlightId = null
        for (const hog of this.hogs) {
            if (!hog.whistled) continue
            hog.whistled = false
            hog.state = 'idle'
            hog.timer = 2
            hog.homeX = hog.x
            hog.homeY = hog.y
        }
    }

    focusOn(hog: Hog) {
        this.highlightId = hog.h.id
    }

    // ------------------------------------------------------------ effects

    burst(x: number, y: number, colors: string[], n: number, speed = 50) {
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2
            const s = speed * (0.4 + Math.random() * 0.8)
            this.particles.push({
                x,
                y,
                vx: Math.cos(a) * s,
                vy: Math.sin(a) * s - speed * 0.6,
                gravity: 140,
                life: 0.6 + Math.random() * 0.6,
                max: 1.2,
                kind: 'pixel',
                color: pick(colors),
            })
        }
    }

    hearts(hog: Hog, n: number) {
        for (let i = 0; i < n; i++) {
            this.particles.push({
                x: hog.x + (Math.random() - 0.5) * 16,
                y: hog.y - 12 - Math.random() * 8,
                vx: (Math.random() - 0.5) * 12,
                vy: -18 - Math.random() * 14,
                life: 1.2 + Math.random() * 0.6,
                max: 1.8,
                kind: 'sprite',
                sprite: S.HEART,
            })
        }
    }

    floatText(x: number, y: number, text: string, color: string, life = 1.8) {
        this.particles.push({ x, y, vx: 0, vy: -14, life, max: life, kind: 'text', text, color })
    }

    // ------------------------------------------------------------ input

    private bindInput() {
        addEventListener('keydown', (e) => {
            if ((e.target as HTMLElement)?.tagName === 'INPUT') return
            this.keys.add(e.key.toLowerCase())
            if (this.mode !== 'play' || this.paused) return
            const k = e.key.toLowerCase()
            if (k === 'e' || k === ' ' || k === 'enter') {
                e.preventDefault()
                this.interact()
            }
            if (k === '+' || k === '=') this.zoomBy(1)
            if (k === '-' || k === '_') this.zoomBy(-1)
            if (k === '0') this.zoomBy(-this.zoomSteps)
        })
        addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()))
        addEventListener('blur', () => this.keys.clear())

        const toWorld = (e: PointerEvent | WheelEvent) => {
            const rect = this.canvas.getBoundingClientRect()
            return {
                x: ((e.clientX - rect.left) * this.dpr) / this.pixelScale + this.camX,
                y: ((e.clientY - rect.top) * this.dpr) / this.pixelScale + this.camY,
            }
        }
        this.canvas.addEventListener('pointermove', (e) => {
            this.pointer = toWorld(e)
            if (!this.touches.has(e.pointerId)) return
            this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
            if (this.touches.size === 2 && this.mode === 'play' && !this.paused) {
                // pinch: one zoom step each time the fingers spread/close by ~25%
                const d = this.touchDistance()
                if (d > this.pinchDist * 1.25 || d < this.pinchDist * 0.8) {
                    this.zoomBy(d > this.pinchDist ? 1 : -1)
                    this.pinchDist = d
                }
            }
        })
        this.canvas.addEventListener('pointerleave', () => (this.pointer = null))
        const releaseTouch = (e: PointerEvent) => this.touches.delete(e.pointerId)
        this.canvas.addEventListener('pointerup', releaseTouch)
        this.canvas.addEventListener('pointercancel', releaseTouch)
        this.canvas.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'touch') {
                this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
                if (this.touches.size >= 2) {
                    this.pinchDist = this.touchDistance()
                    this.moveTarget = null
                    return
                }
            }
            if (this.mode !== 'play' || this.paused) return
            const p = toWorld(e)
            this.pointer = p
            const hog = this.hogAt(p.x, p.y)
            if (hog) {
                if (dist(hog.x, hog.y, this.player.x, this.player.y) < INTERACT_RANGE + 14) this.onHog(hog)
                else this.moveTarget = { x: hog.x, y: hog.y, hog }
                return
            }
            const prop = this.propAt(p.x, p.y)
            if (prop) {
                if (dist(prop.x, prop.y, this.player.x, this.player.y) < 34) this.onProp(prop.action!)
                else this.moveTarget = { x: prop.x, y: prop.y + 6, prop }
                return
            }
            const pond = this.ponds.find((pd) => ((p.x - pd.cx) / pd.rx) ** 2 + ((p.y - pd.cy) / pd.ry) ** 2 <= 1)
            if (pond) {
                this.moveTarget = { x: pond.cx, y: pond.cy + pond.ry + 6 }
                if (dist(this.player.x, this.player.y, pond.cx, pond.cy + pond.ry) < 60) this.onProp('pond')
                return
            }
            this.moveTarget = { x: p.x, y: p.y }
            this.particles.push({ x: p.x, y: p.y, vx: 0, vy: 0, life: 0.4, max: 0.4, kind: 'pixel', color: '#fff' })
        })
        this.canvas.addEventListener(
            'wheel',
            (e) => {
                if (this.mode !== 'play' || this.paused) return
                e.preventDefault()
                // Trackpads send dozens of tiny wheel events per gesture, mice send a few big ones.
                // Accumulate and step at most every 120ms, so one flick = one zoom step.
                // Trackpad pinch arrives as ctrl+wheel with small deltas, so it gets boosted.
                const delta = (e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * (e.ctrlKey ? 4 : 1)
                this.wheelAccum = clamp(this.wheelAccum + delta, -200, 200)
                const now = performance.now()
                if (Math.abs(this.wheelAccum) >= 60 && now - this.lastWheelStep > 120) {
                    this.zoomBy(this.wheelAccum < 0 ? 1 : -1)
                    this.wheelAccum = 0
                    this.lastWheelStep = now
                }
                clearTimeout(this.wheelReset)
                this.wheelReset = window.setTimeout(() => (this.wheelAccum = 0), 150)
            },
            { passive: false }
        )
    }

    zoomBy(steps: number) {
        this.zoomSteps += steps
        this.applyZoom()
    }

    private touchDistance() {
        const [a, b] = [...this.touches.values()]
        return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
    }

    private hogAt(x: number, y: number): Hog | null {
        let best: Hog | null = null
        let bestD = Infinity
        for (const hog of this.hogs) {
            const s = hog.sprite
            if (Math.abs(x - hog.x) < s.width / 2 + 3 && y < hog.y + 4 && y > hog.y - s.height - 3) {
                const d = dist(x, y, hog.x, hog.y - s.height / 2)
                if (d < bestD) [best, bestD] = [hog, d]
            }
        }
        return best
    }

    private propAt(x: number, y: number): Prop | null {
        return (
            this.props.find(
                (p) => p.action && Math.abs(x - p.x) < p.sprite.width / 2 && y < p.y + 2 && y > p.y - p.sprite.height
            ) ?? null
        )
    }

    interact() {
        if (this.nearbyHog) this.onHog(this.nearbyHog)
        else if (this.nearbyProp?.action) this.onProp(this.nearbyProp.action)
        else if (this.nearPond()) this.onProp('pond')
    }

    private nearPond() {
        return this.ponds.some(
            (p) => ((this.player.x - p.cx) / (p.rx + 14)) ** 2 + ((this.player.y - p.cy) / (p.ry + 14)) ** 2 <= 1
        )
    }

    // ------------------------------------------------------------ loop

    resize() {
        this.dpr = window.devicePixelRatio || 1
        const w = innerWidth
        const h = innerHeight
        this.canvas.width = Math.round(w * this.dpr)
        this.canvas.height = Math.round(h * this.dpr)
        this.canvas.style.width = `${w}px`
        this.canvas.style.height = `${h}px`
        this.basePixelScale = Math.round(clamp(Math.floor(Math.min(w / 380, h / 250)), 2, 5) * this.dpr)
        this.applyZoom()
    }

    /**
     * Zoom moves in whole device pixels (so pixel art stays crisp) and keeps whatever is in
     * the middle of the screen in the middle, so the view doesn't jump.
     */
    private applyZoom() {
        const centerX = this.cam.x + this.viewW / 2
        const centerY = this.cam.y + this.viewH / 2
        // never zoom out past the edges of the farm, never zoom in absurdly far
        const min = Math.max(Math.round(1.5 * this.dpr), Math.ceil(Math.max(this.canvas.width / WORLD_W, this.canvas.height / WORLD_H)))
        const max = Math.max(min, Math.round(7 * this.dpr))
        this.pixelScale = clamp(this.basePixelScale + this.zoomSteps, min, max)
        this.zoomSteps = this.pixelScale - this.basePixelScale // don't bank steps past the limits
        this.viewW = this.canvas.width / this.pixelScale
        this.viewH = this.canvas.height / this.pixelScale
        this.cam.x = centerX - this.viewW / 2
        this.cam.y = centerY - this.viewH / 2
    }

    get camX() {
        return Math.round(this.cam.x * this.pixelScale) / this.pixelScale
    }
    get camY() {
        return Math.round(this.cam.y * this.pixelScale) / this.pixelScale
    }

    onScreen(x: number, y: number, pad = 30) {
        return x > this.camX - pad && x < this.camX + this.viewW + pad && y > this.camY - pad && y < this.camY + this.viewH + pad
    }

    frame = () => {
        const now = performance.now()
        const dt = Math.min(0.05, (now - this.lastTime) / 1000)
        this.lastTime = now
        this.update(dt, now)
        this.render(now)
        requestAnimationFrame(this.frame)
    }

    private update(dt: number, now: number) {
        // camera
        if (this.mode === 'title') {
            this.titleAngle += dt * 0.05
            const tx = WORLD_W / 2 + Math.cos(this.titleAngle) * 300 - this.viewW / 2
            const ty = WORLD_H / 2 + Math.sin(this.titleAngle * 1.3) * 180 - this.viewH / 2
            this.cam.x = tx
            this.cam.y = ty
        } else {
            this.updatePlayer(dt)
            const tx = this.player.x - this.viewW / 2
            const ty = this.player.y - 10 - this.viewH / 2
            this.cam.x += (tx - this.cam.x) * Math.min(1, dt * 6)
            this.cam.y += (ty - this.cam.y) * Math.min(1, dt * 6)
        }
        this.cam.x = this.viewW >= WORLD_W ? (WORLD_W - this.viewW) / 2 : clamp(this.cam.x, 0, WORLD_W - this.viewW)
        this.cam.y = this.viewH >= WORLD_H ? (WORLD_H - this.viewH) / 2 : clamp(this.cam.y, 0, WORLD_H - this.viewH)

        // hedgehogs
        const sleepyChance = this.darkness > 0.2 ? 0.08 : 0.35
        const speedMul = this.darkness > 0.2 ? 1.3 : 1
        for (const hog of this.hogs) this.updateHog(hog, dt, now, sleepyChance, speedMul)

        // chatter: a random visible, awake hedgehog says something every few seconds
        if (now > this.nextChatter) {
            this.nextChatter = now + 1500 + Math.random() * 2500
            const visible = this.hogs.filter((h) => !h.bubble && this.onScreen(h.x, h.y, -10))
            if (visible.length) {
                const hog = pick(visible)
                hog.say(
                    chatterFor(hog.h, {
                        lastFedAt: hog.stats[2],
                        day: this.day,
                        sleeping: hog.state === 'sleep',
                    })
                )
            }
        }

        // nearby things + meeting new hedgehogs
        this.nearbyHog = null
        this.nearbyProp = null
        if (this.mode === 'play') {
            let best = INTERACT_RANGE
            for (const hog of this.hogs) {
                const d = dist(hog.x, hog.y - 4, this.player.x, this.player.y - 4)
                if (d < best) [best, this.nearbyHog] = [d, hog]
                if (d < 44) this.onMeet(hog)
                if (d < LINGER_RANGE) hog.nearSince ||= now
                else hog.nearSince = 0
            }
            if (!this.nearbyHog) {
                this.nearbyProp =
                    this.props.find((p) => p.action && dist(p.x, p.y, this.player.x, this.player.y) < (p.action === 'farmer' ? 30 : 22)) ??
                    null
            }
        }
        this.hovered = this.pointer && !isTouch ? this.hogAt(this.pointer.x, this.pointer.y) : null
        this.hoveredProp = this.pointer && !this.hovered && !isTouch ? this.propAt(this.pointer.x, this.pointer.y) : null
        this.canvas.style.cursor = this.hovered || this.hoveredProp ? 'pointer' : 'default'

        // particles
        for (const p of this.particles) {
            p.life -= dt
            p.vy += (p.gravity ?? 0) * dt
            p.x += p.vx * dt
            p.y += p.vy * dt
            if (p.kind === 'firefly') {
                p.vx += (Math.random() - 0.5) * 20 * dt
                p.vy += (Math.random() - 0.5) * 20 * dt
            }
        }
        this.particles = this.particles.filter((p) => p.life > 0)

        // fireflies at night
        if (this.darkness > 0.2 && Math.random() < dt * 6 && this.particles.filter((p) => p.kind === 'firefly').length < 40) {
            this.particles.push({
                x: this.camX + Math.random() * this.viewW,
                y: this.camY + Math.random() * this.viewH,
                vx: (Math.random() - 0.5) * 8,
                vy: (Math.random() - 0.5) * 8,
                life: 6 + Math.random() * 6,
                max: 12,
                kind: 'firefly',
                color: '#F8FF9C',
            })
        }
    }

    private updatePlayer(dt: number) {
        const p = this.player
        let dx = 0
        let dy = 0
        if (!this.paused) {
            if (this.keys.has('arrowleft') || this.keys.has('a')) dx -= 1
            if (this.keys.has('arrowright') || this.keys.has('d')) dx += 1
            if (this.keys.has('arrowup') || this.keys.has('w')) dy -= 1
            if (this.keys.has('arrowdown') || this.keys.has('s')) dy += 1
        }
        if (dx || dy) this.moveTarget = null
        else if (this.moveTarget && !this.paused) {
            const t = this.moveTarget
            if (t.hog) {
                t.x = t.hog.x
                t.y = t.hog.y
                if (dist(t.x, t.y, p.x, p.y) < INTERACT_RANGE - 4) {
                    this.moveTarget = null
                    this.onHog(t.hog)
                    return
                }
            }
            if (t.prop && dist(t.prop.x, t.prop.y, p.x, p.y) < 26) {
                this.moveTarget = null
                this.onProp(t.prop.action!)
                return
            }
            const d = dist(t.x, t.y, p.x, p.y)
            if (d < 2) this.moveTarget = null
            else {
                dx = (t.x - p.x) / d
                dy = (t.y - p.y) / d
            }
        }
        p.moving = !!(dx || dy)
        if (!p.moving) {
            p.anim = 0
            return
        }
        const len = Math.hypot(dx, dy)
        const speed = this.keys.has('shift') ? 120 : 76
        const vx = (dx / len) * speed * dt
        const vy = (dy / len) * speed * dt
        const ox = p.x
        const oy = p.y
        if (!this.isSolid(p.x + vx + Math.sign(vx) * 4, p.y)) p.x += vx
        if (!this.isSolid(p.x, p.y + vy + (vy > 0 ? 1 : -2))) p.y += vy
        if (Math.abs(dx) > Math.abs(dy) * 0.8) {
            p.dir = 'side'
            p.flip = dx < 0
        } else p.dir = dy < 0 ? 'up' : 'down'
        p.anim += dt

        // walking into a wall while auto-walking: give up (and whistle if we were going for a hedgehog)
        if (this.moveTarget && dist(ox, oy, p.x, p.y) < speed * dt * 0.3) {
            this.stuckTime += dt
            if (this.stuckTime > 0.35) {
                const hog = this.moveTarget.hog
                this.moveTarget = null
                this.stuckTime = 0
                if (hog) this.whistle(hog)
            }
        } else this.stuckTime = 0
    }

    private updateHog(hog: Hog, dt: number, now: number, sleepyChance: number, speedMul: number) {
        hog.anim += dt
        if (hog.bubble && now > hog.bubble.until) hog.bubble = null
        if (now < hog.eatUntil) return

        if (hog.whistled) {
            const tx = this.player.x + (hog.x < this.player.x ? -16 : 16)
            const ty = this.player.y
            const d = dist(tx, ty, hog.x, hog.y)
            if (d < 3 || !this.player.visible) {
                hog.whistled = false
                hog.state = 'idle'
                hog.timer = 6
                hog.homeX = hog.x
                hog.homeY = hog.y
                hog.facing = this.player.x < hog.x ? -1 : 1
                if (this.player.visible && !this.paused) this.onHog(hog)
                return
            }
            const step = Math.min(d, 150 * dt)
            hog.x += ((tx - hog.x) / d) * step
            hog.y += ((ty - hog.y) / d) * step
            hog.facing = tx < hog.x ? -1 : 1
            if (Math.random() < dt * 20) this.particles.push({ x: hog.x, y: hog.y, vx: -hog.facing * 10, vy: -5, life: 0.4, max: 0.4, kind: 'pixel', color: '#d8c8a0' })
            return
        }

        const zooming = hog.zooming
        hog.timer -= dt
        if (hog.state === 'sleep') {
            hog.zTimer -= dt
            if (hog.zTimer <= 0 && this.onScreen(hog.x, hog.y)) {
                hog.zTimer = 1.2
                this.floatText(hog.x + 4, hog.y - 12, 'z', '#ffffff', 1.6)
            }
            if (hog.timer <= 0 || zooming) [hog.state, hog.timer] = ['idle', 1]
            return
        }
        if (hog.state === 'idle') {
            if (hog.timer > 0 && !zooming) return
            if (!zooming && Math.random() < sleepyChance) {
                hog.state = 'sleep'
                hog.timer = 8 + Math.random() * 20
                return
            }
            const range = zooming ? 140 : 70
            for (let i = 0; i < 6; i++) {
                const tx = clamp(hog.homeX + (Math.random() - 0.5) * range * 2, 30, WORLD_W - 30)
                const ty = clamp(hog.homeY + (Math.random() - 0.5) * range * 2, 40, WORLD_H - 30)
                if (!this.isSolid(tx, ty, 4)) {
                    hog.tx = tx
                    hog.ty = ty
                    hog.state = 'walk'
                    break
                }
            }
            hog.timer = 1 + Math.random() * 4
            return
        }
        // walking
        const speed = (zooming ? 120 : 14 + (hog.h.id % 7)) * speedMul
        const d = dist(hog.tx, hog.ty, hog.x, hog.y)
        if (d < 1.5) {
            hog.state = 'idle'
            hog.timer = zooming ? 0 : 1 + Math.random() * 5
            return
        }
        const nx = hog.x + ((hog.tx - hog.x) / d) * Math.min(d, speed * dt)
        const ny = hog.y + ((hog.ty - hog.y) / d) * Math.min(d, speed * dt)
        if (this.isSolid(nx, ny, 2)) {
            hog.state = 'idle'
            hog.timer = 0.5
            return
        }
        hog.facing = hog.tx < hog.x ? -1 : 1
        hog.x = nx
        hog.y = ny
        if (zooming && Math.random() < dt * 30) {
            this.particles.push({ x: hog.x - hog.facing * 6, y: hog.y - 2, vx: -hog.facing * 20, vy: -10, life: 0.3, max: 0.3, kind: 'pixel', color: '#ffffff' })
        }
    }

    // ------------------------------------------------------------ rendering

    private render(now: number) {
        const ctx = this.ctx
        const ps = this.pixelScale
        const camX = this.camX
        const camY = this.camY
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.imageSmoothingEnabled = false
        ctx.fillStyle = '#2b5a22'
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
        ctx.setTransform(ps, 0, 0, ps, -camX * ps, -camY * ps)

        // terrain (only the visible part)
        const sx = Math.max(0, Math.floor(camX))
        const sy = Math.max(0, Math.floor(camY))
        const sw = Math.min(WORLD_W - sx, Math.ceil(this.viewW) + 2)
        const sh = Math.min(WORLD_H - sy, Math.ceil(this.viewH) + 2)
        if (sw > 0 && sh > 0) ctx.drawImage(this.terrain, sx, sy, sw, sh, sx, sy, sw, sh)

        // pond shimmer
        for (const p of this.ponds) {
            if (!this.onScreen(p.cx, p.cy, p.rx)) continue
            ctx.fillStyle = 'rgba(255,255,255,0.55)'
            for (let i = 0; i < 6; i++) {
                const a = (now / 3000 + i * 1.7) % (Math.PI * 2)
                const r = 0.25 + ((i * 0.13) % 0.5)
                const x = Math.round(p.cx + Math.cos(a * (i % 2 ? 1 : -1)) * p.rx * r)
                const y = Math.round(p.cy + Math.sin(a) * p.ry * r)
                if (Math.sin(now / 400 + i) > 0.3) ctx.fillRect(x, y, 3, 1)
            }
        }

        // highlight ring under the focused hedgehog
        const highlighted = this.highlightId ? this.hogById.get(this.highlightId) : null
        if (highlighted) {
            const pulse = 6 + Math.sin(now / 150) * 1.5
            ctx.strokeStyle = '#FFE066'
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.ellipse(highlighted.x, highlighted.y, pulse * 2, pulse, 0, 0, Math.PI * 2)
            ctx.stroke()
        }

        // y-sorted world objects
        type Drawable = { y: number; draw: () => void }
        const items: Drawable[] = []
        for (const prop of this.props) {
            if (!this.onScreen(prop.x, prop.y, 70)) continue
            items.push({
                y: prop.y,
                draw: () => {
                    const s = prop.sprite
                    ctx.drawImage(s, Math.round(prop.x - s.width / 2), Math.round(prop.y - s.height))
                },
            })
        }
        for (const hog of this.hogs) {
            if (!this.onScreen(hog.x, hog.y)) continue
            items.push({ y: hog.y, draw: () => this.drawHog(hog, now) })
        }
        if (this.player.visible) items.push({ y: this.player.y, draw: () => this.drawPlayer(now) })
        items.sort((a, b) => a.y - b.y)
        for (const it of items) it.draw()

        // world-space particles
        for (const p of this.particles) {
            const a = Math.min(1, p.life / (p.max * 0.4))
            ctx.globalAlpha = a
            if (p.kind === 'pixel') {
                ctx.fillStyle = p.color!
                ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1)
            } else if (p.kind === 'sprite') {
                ctx.drawImage(p.sprite!, Math.round(p.x - p.sprite!.width / 2), Math.round(p.y - p.sprite!.height / 2))
            }
            ctx.globalAlpha = 1
        }

        // night
        if (this.darkness > 0.01) {
            ctx.setTransform(1, 0, 0, 1, 0, 0)
            ctx.fillStyle = `rgba(16, 20, 64, ${this.darkness})`
            ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
            ctx.setTransform(ps, 0, 0, ps, -camX * ps, -camY * ps)
            for (const p of this.particles) {
                if (p.kind !== 'firefly') continue
                const glow = 0.5 + Math.sin(now / 200 + p.x) * 0.5
                ctx.globalAlpha = Math.min(1, p.life) * glow * 0.35
                ctx.fillStyle = p.color!
                ctx.fillRect(Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3)
                ctx.globalAlpha = Math.min(1, p.life) * glow
                ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1)
            }
            ctx.globalAlpha = 1
            // a little lantern glow around the farmer
            if (this.player.visible) {
                const g = ctx.createRadialGradient(this.player.x, this.player.y - 8, 2, this.player.x, this.player.y - 8, 50)
                g.addColorStop(0, `rgba(255, 220, 140, ${this.darkness * 0.5})`)
                g.addColorStop(1, 'rgba(255, 220, 140, 0)')
                ctx.fillStyle = g
                ctx.fillRect(this.player.x - 50, this.player.y - 58, 100, 100)
            }
        }

        // screen-space: labels, bubbles, text particles
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        this.drawOverlays(now)
    }

    private drawHog(hog: Hog, now: number) {
        const ctx = this.ctx
        const s = hog.sprite
        let bob = 0
        if (now < hog.hopUntil) bob = -Math.round(Math.abs(Math.sin(now / 90)) * 4)
        else if (hog.state === 'sleep') bob = Math.sin(now / 600 + hog.h.id) > 0 ? 0 : 1
        const x0 = Math.round(hog.x - s.width / 2)
        const y0 = Math.round(hog.y - s.height + 3 + bob)
        ctx.fillStyle = 'rgba(0,0,0,0.22)'
        ctx.beginPath()
        ctx.ellipse(Math.round(hog.x), Math.round(hog.y), s.width * 0.38, 2, 0, 0, Math.PI * 2)
        ctx.fill()
        if (hog.facing === -1) {
            ctx.save()
            ctx.translate(x0 + s.width, y0)
            ctx.scale(-1, 1)
            ctx.drawImage(s, 0, 0)
            ctx.restore()
        } else ctx.drawImage(s, x0, y0)
        if (this.partyIds.has(hog.h.id)) {
            // party hat on the head (the head is at the front), plus a little confetti
            const hat = S.PARTY_HAT
            const hx = Math.round(hog.x + hog.facing * s.width * 0.18 - hat.width / 2)
            ctx.drawImage(hat, hx, y0 - hat.height + 3)
            if (Math.random() < 0.06) {
                this.particles.push({
                    x: hog.x + (Math.random() - 0.5) * s.width * 1.5,
                    y: y0 - 6,
                    vx: (Math.random() - 0.5) * 16,
                    vy: -10 - Math.random() * 10,
                    gravity: 30,
                    life: 1.2,
                    max: 1.2,
                    kind: 'pixel',
                    color: pick(['#FF5C8A', '#FFE066', '#2F80FA', '#36C46F', '#B62AD9']),
                })
            }
        }
        if (now < hog.eatUntil && hog.eatingFood) {
            const f = S.foodSprite(hog.eatingFood)
            const bite = Math.floor(((hog.eatUntil - now) / 2200) * 8)
            ctx.drawImage(f, 0, 0, f.width, f.height, Math.round(hog.x + hog.facing * (s.width / 2 + 2) - 4), Math.round(hog.y - 7), Math.max(2, bite), 8)
        }
    }

    private drawPlayer(now: number) {
        const ctx = this.ctx
        const p = this.player
        const frame = p.moving ? 1 + (Math.floor(p.anim / 0.14) % 2) : 0
        const s = S.farmerSprite(p.dir, frame)
        const x0 = Math.round(p.x - s.width / 2)
        const y0 = Math.round(p.y - s.height + 1 - (p.moving && frame === 1 ? 1 : 0))
        ctx.fillStyle = 'rgba(0,0,0,0.25)'
        ctx.beginPath()
        ctx.ellipse(Math.round(p.x), Math.round(p.y), 5, 2, 0, 0, Math.PI * 2)
        ctx.fill()
        if (p.flip) {
            ctx.save()
            ctx.translate(x0 + s.width, y0)
            ctx.scale(-1, 1)
            ctx.drawImage(s, 0, 0)
            ctx.restore()
        } else ctx.drawImage(s, x0, y0)
        // selection pointer on move target
        if (this.moveTarget && !this.moveTarget.hog && !this.moveTarget.prop) {
            const t = this.moveTarget
            const r = 3 + Math.round(Math.sin(now / 100))
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(Math.round(t.x) - r, Math.round(t.y), 2, 1)
            ctx.fillRect(Math.round(t.x) + r - 1, Math.round(t.y), 2, 1)
        }
    }

    private toScreen(x: number, y: number): [number, number] {
        return [Math.round((x - this.camX) * this.pixelScale), Math.round((y - this.camY) * this.pixelScale)]
    }

    private drawOverlays(now: number) {
        const ctx = this.ctx
        const u = this.dpr
        const labelFont = `${Math.round(8 * u)}px "Press Start 2P"`
        const bubbleFont = `${Math.round(18 * u)}px VT323`

        // text particles (+XP, z)
        for (const p of this.particles) {
            if (p.kind !== 'text') continue
            const [x, y] = this.toScreen(p.x, p.y)
            ctx.globalAlpha = Math.min(1, p.life / (p.max * 0.4))
            ctx.font = p.text === 'z' ? `${Math.round(10 * u)}px "Press Start 2P"` : `${Math.round(10 * u)}px "Press Start 2P"`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'bottom'
            ctx.fillStyle = '#2a1a12'
            ctx.fillText(p.text!, x + 2 * u, y + 2 * u)
            ctx.fillStyle = p.color!
            ctx.fillText(p.text!, x, y)
        }
        ctx.globalAlpha = 1
        if (this.mode !== 'play') return

        // name labels
        const labelled = new Set<Hog>()
        if (this.showNames) for (const h of this.hogs) if (this.onScreen(h.x, h.y)) labelled.add(h)
        if (this.hovered) labelled.add(this.hovered)
        if (this.nearbyHog) labelled.add(this.nearbyHog)
        const hl = this.highlightId ? this.hogById.get(this.highlightId) : null
        if (hl) labelled.add(hl)
        for (const hog of this.hogs) if (hog.whistled) labelled.add(hog)
        // hedgehogs we've been hanging around for a couple of seconds (closest 3, to avoid clutter)
        const lingering = new Set(
            this.hogs
                .filter((h) => h.nearSince && now - h.nearSince >= LINGER_MS)
                .sort((a, b) => dist(a.x, a.y, this.player.x, this.player.y) - dist(b.x, b.y, this.player.x, this.player.y))
                .slice(0, 3)
        )
        for (const hog of lingering) labelled.add(hog)
        const showsPortrait = (hog: Hog) => hog === this.hovered || hog === this.nearbyHog || hog === hl || lingering.has(hog)

        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        for (const hog of labelled) {
            const focused = hog === this.hovered || hog === this.nearbyHog || hog === hl
            const s = hog.sprite
            const party = this.partyIds.has(hog.h.id)
            const [x, yTop] = this.toScreen(hog.x, hog.y - s.height - (party ? 8 : 0))
            let y = yTop - 10 * u
            const text = `${party ? '★ ' : ''}${hog.h.shortName.toUpperCase()} Lv${hog.level}`
            ctx.font = labelFont
            const w = ctx.measureText(text).width + 8 * u
            const h = 14 * u
            this.box(x - w / 2, y - h / 2, w, h, party ? '#FFB3CF' : focused ? '#FFFFFF' : 'rgba(255,255,255,0.85)')
            ctx.fillStyle = '#2a1a12'
            ctx.fillText(text, x, y + u)
            if (showsPortrait(hog)) {
                const portrait = S.portraitIfReady(hog.h.avatar, 16)
                if (portrait) {
                    // lingering portraits fade in rather than popping
                    if (!focused) ctx.globalAlpha = Math.min(1, (now - hog.nearSince - LINGER_MS) / 200)
                    const size = Math.max(32, 16 * Math.round(this.pixelScale / 1.5))
                    const py = y - h / 2 - size - 4 * u
                    this.box(x - size / 2 - 2 * u, py - 2 * u, size + 4 * u, size + 4 * u, hog.h.color)
                    ctx.imageSmoothingEnabled = false
                    ctx.drawImage(portrait, x - size / 2, py, size, size)
                    ctx.globalAlpha = 1
                    y = py
                }
                if (hog === this.nearbyHog && !this.paused) {
                    const prompt = isTouch ? 'TAP TO SAY HI' : '[E] SAY HI'
                    ctx.font = labelFont
                    const pw = ctx.measureText(prompt).width + 8 * u
                    const [, by] = this.toScreen(hog.x, hog.y)
                    const blink = Math.floor(now / 400) % 2 ? '#FFE066' : '#FFC93C'
                    this.box(x - pw / 2, by + 6 * u, pw, h, blink)
                    ctx.fillStyle = '#2a1a12'
                    ctx.fillText(prompt, x, by + 6 * u + h / 2 + u)
                }
            }
        }

        // prop prompt
        const prop = this.nearbyProp ?? this.hoveredProp
        if (prop?.label) {
            const [x, y] = this.toScreen(prop.x, prop.y - prop.sprite.height)
            const text = this.nearbyProp && !isTouch ? `[E] ${prop.label}` : prop.label
            ctx.font = labelFont
            const w = ctx.measureText(text).width + 8 * u
            const h = 14 * u
            this.box(x - w / 2, y - h - 4 * u, w, h, '#FFE066')
            ctx.fillStyle = '#2a1a12'
            ctx.fillText(text, x, y - h / 2 - 4 * u + u)
        } else if (!this.nearbyHog && this.nearPond()) {
            const [x, y] = this.toScreen(this.player.x, this.player.y - 26)
            const text = isTouch ? 'TAP THE POND' : '[E] STARE INTO THE POND'
            ctx.font = labelFont
            const w = ctx.measureText(text).width + 8 * u
            this.box(x - w / 2, y - 14 * u, w, 14 * u, '#9FC4FF')
            ctx.fillStyle = '#2a1a12'
            ctx.fillText(text, x, y - 7 * u + u)
        }

        // speech bubbles
        ctx.font = bubbleFont
        ctx.textAlign = 'left'
        for (const hog of this.hogs) {
            if (!hog.bubble || !this.onScreen(hog.x, hog.y)) continue
            const lines = wrap(hog.bubble.text, 22)
            const lh = 16 * u
            const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 10 * u
            const h = lines.length * lh + 6 * u
            const [hx, hy] = this.toScreen(hog.x + hog.facing * 6, hog.y - hog.sprite.height - 2)
            const offset = labelled.has(hog) ? (showsPortrait(hog) ? 70 : 22) * u : 0
            const bx = Math.round(hx - w / 2)
            const by = Math.round(hy - h - 8 * u - offset)
            this.box(bx, by, w, h, '#FFFFFF')
            // tail
            ctx.fillStyle = '#2a1a12'
            ctx.fillRect(hx - 2 * u, by + h, 6 * u, 2 * u)
            ctx.fillRect(hx - u, by + h + 2 * u, 3 * u, 2 * u)
            ctx.fillStyle = '#FFFFFF'
            ctx.fillRect(hx - u, by + h - 2 * u, 4 * u, 2 * u)
            ctx.fillStyle = '#2a1a12'
            lines.forEach((l, i) => ctx.fillText(l, bx + 5 * u, by + 3 * u + lh * i + lh / 2 + u))
        }

        // compass: an arrow orbiting the farmer, so the HUD in the screen corners never hides it.
        // Points at whoever you whistled or are tracking, or at the nearest party hog while your snack is ready.
        const tracked = this.hogs.find((h) => h.whistled) ?? hl
        const target = tracked ?? (this.partyCompass ? this.nearestPartyHog() : undefined)
        const distance = target ? dist(target.x, target.y, this.player.x, this.player.y) : 0
        if (target && this.player.visible && distance > 56) {
            const party = this.partyIds.has(target.h.id)
            const [px, py] = this.toScreen(this.player.x, this.player.y - 8)
            const a = Math.atan2(target.y - (this.player.y - 8), target.x - this.player.x)
            const ps = this.pixelScale
            const r = (28 + Math.sin(now / 180) * 2) * ps
            const size = tracked ? ps : ps * 0.75
            ctx.save()
            ctx.translate(px + Math.cos(a) * r, py + Math.sin(a) * r)
            ctx.rotate(a)
            ctx.fillStyle = '#2a1a12'
            ctx.beginPath()
            ctx.moveTo(7 * size, 0)
            ctx.lineTo(-4 * size, -6 * size)
            ctx.lineTo(-1 * size, 0)
            ctx.lineTo(-4 * size, 6 * size)
            ctx.fill()
            ctx.fillStyle = tracked ? '#FFE066' : '#FFC93C'
            ctx.beginPath()
            ctx.moveTo(5 * size, 0)
            ctx.lineTo(-2.5 * size, -4 * size)
            ctx.lineTo(0, 0)
            ctx.lineTo(-2.5 * size, 4 * size)
            ctx.fill()
            ctx.restore()

            const lr = r + 16 * ps
            const lx = px + Math.cos(a) * lr
            const ly = py + Math.sin(a) * lr
            ctx.font = labelFont
            ctx.textAlign = 'center'
            const name = `${party ? '★ ' : ''}${target.h.shortName.toUpperCase()} ${Math.round(distance / 16)}m`
            const w = ctx.measureText(name).width + 8 * u
            this.box(lx - w / 2, ly - 7 * u, w, 14 * u, tracked ? '#FFE066' : 'rgba(255, 233, 150, 0.9)')
            ctx.fillStyle = '#2a1a12'
            ctx.fillText(name, lx, ly + u)
        }
    }

    /** Pixel-art box with a dark border and drop shadow, in device pixels */
    private box(x: number, y: number, w: number, h: number, fill: string) {
        const ctx = this.ctx
        const u = Math.max(1, Math.round(this.dpr))
        x = Math.round(x)
        y = Math.round(y)
        w = Math.round(w)
        h = Math.round(h)
        ctx.fillStyle = 'rgba(0,0,0,0.3)'
        ctx.fillRect(x + u * 2, y + u * 2, w, h)
        ctx.fillStyle = '#2a1a12'
        ctx.fillRect(x + u, y - u, w - 2 * u, h + 2 * u)
        ctx.fillRect(x - u, y + u, w + 2 * u, h - 2 * u)
        ctx.fillRect(x, y, w, h)
        ctx.fillStyle = fill
        ctx.fillRect(x + u, y + u, w - 2 * u, h - 2 * u)
    }

    // ------------------------------------------------------------ minimap

    drawMinimap(canvas: HTMLCanvasElement, now: number) {
        const ctx = canvas.getContext('2d')!
        const scale = canvas.width / WORLD_W
        ctx.imageSmoothingEnabled = true
        ctx.drawImage(this.terrain, 0, 0, canvas.width, canvas.height)
        ctx.fillStyle = 'rgba(0,0,0,0.15)'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        for (const prop of this.props) {
            if (prop.sprite.width < 20) continue
            ctx.fillStyle = prop.action === 'farmer' ? '#C0392B' : '#1B5E20'
            const w = Math.max(2, prop.sprite.width * scale)
            ctx.fillRect(prop.x * scale - w / 2, (prop.y - prop.sprite.height / 2) * scale - w / 2, w, w)
        }
        for (const hog of this.hogs) {
            ctx.fillStyle = hog.h.color
            ctx.fillRect(Math.round(hog.x * scale) - 1, Math.round(hog.y * scale) - 1, 2, 2)
        }
        const special = [...this.partyIds].map((id) => this.hogById.get(id))
        if (this.highlightId) special.push(this.hogById.get(this.highlightId))
        special.forEach((hog) => {
            if (!hog) return
            ctx.fillStyle = hog.h.id === this.highlightId ? '#ffffff' : '#FF5C8A'
            ctx.fillRect(Math.round(hog.x * scale) - 2, Math.round(hog.y * scale) - 2, 4, 4)
        })
        if (this.player.visible && Math.floor(now / 300) % 2) {
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(Math.round(this.player.x * scale) - 2, Math.round(this.player.y * scale) - 2, 5, 5)
            ctx.fillStyle = '#F54E00'
            ctx.fillRect(Math.round(this.player.x * scale) - 1, Math.round(this.player.y * scale) - 1, 3, 3)
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.7)'
        ctx.lineWidth = 1
        ctx.strokeRect(this.camX * scale + 0.5, this.camY * scale + 0.5, this.viewW * scale, this.viewH * scale)
    }
}

function wrap(text: string, max: number): string[] {
    const words = text.split(' ')
    const lines: string[] = []
    let line = ''
    for (const w of words) {
        if ((line + ' ' + w).trim().length > max && line) {
            lines.push(line)
            line = w
        } else line = (line + ' ' + w).trim()
    }
    if (line) lines.push(line)
    return lines
}
