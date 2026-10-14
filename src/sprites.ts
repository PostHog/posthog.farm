// All art is generated at runtime: procedural hedgehogs (so every chonk stage is pixel-perfect),
// a few hand-drawn pixel maps, and pixelated + posterized avatars.

import type { FoodId } from '../shared/game'

export type Sprite = HTMLCanvasElement

export function makeCanvas(w: number, h: number): Sprite {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
}

export function hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.replace('#', ''), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function shade(hex: string, amount: number): string {
    const [r, g, b] = hexToRgb(hex)
    const f = (c: number) => Math.round(Math.max(0, Math.min(255, amount < 0 ? c * (1 + amount) : c + (255 - c) * amount)))
    return `rgb(${f(r)},${f(g)},${f(b)})`
}

/** Builds a sprite from rows of characters, each mapped to a color ('.' is transparent) */
export function fromMap(rows: string[], palette: Record<string, string>): Sprite {
    const c = makeCanvas(rows[0].length, rows.length)
    const ctx = c.getContext('2d')!
    rows.forEach((row, y) =>
        [...row].forEach((ch, x) => {
            if (ch === '.' || ch === ' ' || !palette[ch]) return
            ctx.fillStyle = palette[ch]
            ctx.fillRect(x, y, 1, 1)
        })
    )
    return c
}

function fromGrid(grid: (string | null)[][]): Sprite {
    const c = makeCanvas(grid[0].length, grid.length)
    const ctx = c.getContext('2d')!
    grid.forEach((row, y) =>
        row.forEach((col, x) => {
            if (!col) return
            ctx.fillStyle = col
            ctx.fillRect(x, y, 1, 1)
        })
    )
    return c
}

// ---------------------------------------------------------------- hedgehogs

const OUTLINE = '#2a1a12'
const SKIN = '#EBC9A0'
const SKIN_DARK = '#C99D72'
const STAGE_SIZE: [number, number][] = [
    [12, 8],
    [14, 10],
    [16, 11],
    [19, 13],
    [23, 16],
]

export type HogFrame = 'walk0' | 'walk1' | 'sleep' | 'eat'

const hogCache = new Map<string, Sprite>()

export function hedgehogSprite(color: string, stage: number, frame: HogFrame): Sprite {
    const key = `${color}|${stage}|${frame}`
    let s = hogCache.get(key)
    if (!s) hogCache.set(key, (s = buildHedgehog(color, stage, frame)))
    return s
}

function buildHedgehog(color: string, stage: number, frame: HogFrame): Sprite {
    const [W, H] = STAGE_SIZE[stage]
    const cw = W + 7
    const ch = H + 6
    const grid: (string | null)[][] = Array.from({ length: ch }, () => Array(cw).fill(null))
    const kind: (null | 'spine' | 'skin')[][] = Array.from({ length: ch }, () => Array(cw).fill(null))
    const cx = 2 + W / 2
    const cy = 2 + H / 2
    const rx = W / 2
    const ry = H / 2
    const fx = cx + rx * 0.5
    const fy = cy + ry * 0.28
    const frx = rx * 0.52
    const fry = ry * 0.62
    const dark = shade(color, -0.35)
    const light = shade(color, 0.35)

    const inBody = (x: number, y: number) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1
    const inFace = (x: number, y: number) => ((x + 0.5 - fx) / frx) ** 2 + ((y + 0.5 - fy) / fry) ** 2 <= 1

    for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
            if (!inBody(x, y)) continue
            if (inFace(x, y) || y + 0.5 > cy + ry * 0.62) {
                kind[y][x] = 'skin'
                grid[y][x] = y + 0.5 > cy + ry * 0.7 ? SKIN_DARK : SKIN
            } else {
                kind[y][x] = 'spine'
                grid[y][x] = (x * 2 + y) % 5 === 0 ? dark : (x + y * 3) % 7 === 0 ? light : color
            }
        }
    }
    // spiky top edge
    for (let x = 0; x < cw; x++) {
        for (let y = 1; y < ch; y++) {
            if (kind[y][x] === 'spine' && !kind[y - 1][x]) {
                if (x % 2 === 0) grid[y - 1][x] = dark
                break
            }
        }
    }
    // snout
    const sy = Math.round(fy)
    let edge = 0
    for (let x = cw - 1; x >= 0; x--) if (kind[sy][x]) { edge = x; break }
    grid[sy][edge + 1] = SKIN
    grid[sy][edge + 2] = SKIN
    grid[sy + 1][edge + 1] = SKIN_DARK
    grid[sy][edge + 3] = OUTLINE // nose
    if (frame === 'eat') grid[sy + 1][edge + 2] = '#7a2a2a'

    // eye + cheek
    const ex = Math.round(fx + frx * 0.15)
    const ey = Math.round(fy - fry * 0.45)
    if (frame === 'sleep') {
        grid[ey][ex] = OUTLINE
        grid[ey][ex - 1] = OUTLINE
    } else {
        grid[ey][ex] = '#111'
        if (stage >= 2) {
            grid[ey + 1][ex] = '#111'
            grid[ey][ex - 1] = '#111'
            grid[ey + 1][ex - 1] = '#111'
            grid[ey][ex - 1] = '#fff'
        }
    }
    if (kind[ey + 2]?.[ex] === 'skin') grid[ey + 2][ex] = '#F49AB0'

    // feet
    if (frame !== 'sleep') {
        const bottom = Math.floor(cy + ry)
        const shift = frame === 'walk1' ? 1 : 0
        for (const fxp of [Math.round(cx - rx * 0.45) - shift, Math.round(cx + rx * 0.4) + shift]) {
            grid[bottom][fxp] = SKIN_DARK
            grid[bottom][fxp + 1] = SKIN_DARK
        }
    }

    // outline everything
    const out = grid.map((r) => [...r])
    for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
            if (grid[y][x]) continue
            const n = [grid[y - 1]?.[x], grid[y + 1]?.[x], grid[y][x - 1], grid[y][x + 1]]
            if (n.some((c) => c && c !== OUTLINE)) out[y][x] = OUTLINE
        }
    }
    return fromGrid(out)
}

// ---------------------------------------------------------------- farmer

const FARMER_PALETTE = {
    x: OUTLINE,
    h: '#F2CD5C',
    H: '#B8892E',
    n: '#6B3E1F',
    s: '#F1C29A',
    e: '#222',
    m: '#C0605A',
    r: '#F54E00',
    o: '#2F80FA',
    O: '#1B56B8',
    k: '#4A2E1C',
}

const FARMER_TOP = {
    down: [
        '...xxxxxx...',
        '..xhhhhhhx..',
        'xxhhhhhhhhxx',
        'xHHHHHHHHHHx',
        '.xnssssssnx.',
        '.xsessssesx.',
        '.xssssssssx.',
        '..xssmmssx..',
        '..xrrrrrrx..',
        '.xrorrrrorx.',
        'xsoooooooosx',
        '.xoooooooox.',
        '.xooOOOOoox.',
    ],
    up: [
        '...xxxxxx...',
        '..xhhhhhhx..',
        'xxhhhhhhhhxx',
        'xHHHHHHHHHHx',
        '.xnnnnnnnnx.',
        '.xnnnnnnnnx.',
        '.xsnnnnnnsx.',
        '..xssssssx..',
        '..xrrrrrrx..',
        '.xrorrrrorx.',
        'xsoooooooosx',
        '.xoooooooox.',
        '.xooOOOOoox.',
    ],
    side: [
        '....xxxxx...',
        '...xhhhhhx..',
        '.xxhhhhhhhxx',
        'xHHHHHHHHHHx',
        '.xnnsssssx..',
        '.xnssssesx..',
        '.xnsssssssx.',
        '..xsssmsx...',
        '..xrrrrrx...',
        '..xrrorrx...',
        '.xoooosoox..',
        '.xooooooox..',
        '.xOOOOOOOx..',
    ],
}

const FARMER_LEGS = {
    down: [
        ['.xOOx..xOOx.', '.xkkx..xkkx.', '.xxxx..xxxx.'],
        ['.xOOx..xOOx.', '.xkkx..xxxx.', '.xxxx.......'],
        ['.xOOx..xOOx.', '.xxxx..xkkx.', '.......xxxx.'],
    ],
    side: [
        ['..xOOxOOx...', '..xkkxkkkx..', '..xxxxxxxx..'],
        ['.xOOx.xOOx..', '.xkkx.xkkkx.', '.xxxx.xxxxx.'],
        ['..xOOxOOx...', '..xkkxkkkx..', '..xxxxxxxx..'],
    ],
}

export type FarmerDir = 'down' | 'up' | 'side'
const farmerCache = new Map<string, Sprite>()

export function farmerSprite(dir: FarmerDir, frame: number): Sprite {
    const key = `${dir}${frame}`
    let s = farmerCache.get(key)
    if (!s) {
        const legs = (dir === 'side' ? FARMER_LEGS.side : FARMER_LEGS.down)[frame]
        farmerCache.set(key, (s = fromMap([...FARMER_TOP[dir], ...legs], FARMER_PALETTE)))
    }
    return s
}

// ---------------------------------------------------------------- food & icons

const FOOD_MAPS: Record<FoodId, [string[], Record<string, string>]> = {
    mealworm: [
        ['........', '...xx...', '..xaax..', '..xbax..', '...xabx.', '....xbax', '.xx..xbx', 'xaax.xax'],
        { x: OUTLINE, a: '#E6B566', b: '#B07A2E' },
    ],
    strawberry: [
        ['...gg...', '..gGGg..', '.xrrrrx.', 'xrryrrrx', 'xrrrryrx', '.xryrrx.', '..xrrx..', '...xx...'],
        { x: '#7a1424', r: '#E8384F', y: '#FFE066', g: '#4CAF50', G: '#2e7d32' },
    ],
    catfood: [
        ['.xxxxxx.', 'xccccccx', 'xCCCCCCx', 'xllwwllx', 'xlwllwlx', 'xllllllx', 'xCCCCCCx', '.xxxxxx.'],
        { x: OUTLINE, c: '#C9D1D9', C: '#7B848D', l: '#F54E00', w: '#fff' },
    ],
    pizza: [
        ['xxxxxxxx', 'xccccccx', '.xyPyrx.', '.xryyPx.', '..xPyx..', '..xyrx..', '...xx...', '........'],
        { x: '#7a4a1a', c: '#C2782E', y: '#F7C04A', P: '#FFF06B', r: '#E8384F' },
    ],
    coffee: [
        ['..s..s..', '...s..s.', 'xxxxxx..', 'xbbbbxxx', 'xwwwwx.x', 'xwwwwxxx', '.xwwx...', '..xx....'],
        { x: OUTLINE, b: '#6B3E1F', w: '#fff', s: '#cfd8dc' },
    ],
    flag: [
        ['.xxxxxx.', '.xfffffx', '.xfwwffx', '.xfffffx', '.xxxxxx.', '.x......', '.x......', 'xxx.....'],
        { x: OUTLINE, f: '#F54E00', w: '#FFD3BE' },
    ],
    water: [
        ['...xx...', '..xwwx..', '..xggx..', '.xggggx.', '.xllllx.', '.xgbggx.', '.xggbgx.', '..xxxx..'],
        { x: '#1f5a6b', g: '#7FD3E6', w: '#3AA6C2', l: '#fff', b: '#E0F7FF' },
    ],
    mystery: [
        ['xxxxxxxx', 'xbbqqbbx', 'xbqbbqbx', 'xbbbbqbx', 'xBBBqBBx', 'xbbbbbbx', 'xbbbqbbx', 'xxxxxxxx'],
        { x: OUTLINE, b: '#B07A2E', B: '#7A5220', q: '#FFE066' },
    ],
}

const foodCache = new Map<FoodId, Sprite>()
export function foodSprite(id: FoodId): Sprite {
    let s = foodCache.get(id)
    if (!s) foodCache.set(id, (s = fromMap(...FOOD_MAPS[id])))
    return s
}

export const HEART = fromMap(['.x.x.', 'xrxrx', 'xrrrx', '.xrx.', '..x..'], { x: '#7a1424', r: '#FF5C8A' })
export const PARTY_HAT = fromMap(
    ['..y.y..', '...y...', '..yxy..', '..xpx..', '..xbx..', '.xpppx.', '.xyyyx.', 'xbbbbbx', 'xxxxxxx'],
    { x: OUTLINE, p: '#FF5C8A', y: '#FFE066', b: '#2F80FA' }
)
export const SOCK = fromMap(['.xxx.', '.xwx.', '.xwx.', 'xwwx.', 'xwwx.', '.xx..'], { x: OUTLINE, w: '#eee' })

// ---------------------------------------------------------------- props

export function treeSprite(variant: number): Sprite {
    const w = 22
    const h = 28
    const grid: (string | null)[][] = Array.from({ length: h }, () => Array(w).fill(null))
    const greens = [
        ['#2E7D32', '#43A047', '#66BB6A'],
        ['#33691E', '#558B2F', '#7CB342'],
        ['#1B5E20', '#2E7D32', '#4CAF50'],
    ][variant % 3]
    const blobs = [
        [11, 9, 8],
        [6, 13, 5.5],
        [16, 13, 5.5],
        [11, 15, 6],
    ]
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const inside = blobs.some(([bx, by, r]) => (x + 0.5 - bx) ** 2 + (y + 0.5 - by) ** 2 <= r * r)
            if (!inside) continue
            const hl = (x + 0.5 - 8) ** 2 + (y + 0.5 - 6) ** 2 < 14
            const shadow = y > 15 || (x + y) % 9 === 0
            grid[y][x] = hl ? greens[2] : shadow ? greens[0] : greens[1]
        }
    // trunk
    for (let y = 19; y < h - 1; y++)
        for (let x = 9; x < 13; x++) grid[y][x] = x === 9 ? '#5D3A1A' : x === 12 ? '#4A2E14' : '#7A4E24'
    // some fruit on variant 1
    if (variant % 4 === 1) for (const [x, y] of [[6, 10], [14, 7], [16, 14], [9, 15]]) grid[y][x] = '#E8384F'
    const out = grid.map((r) => [...r])
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            if (grid[y][x]) continue
            if ([grid[y - 1]?.[x], grid[y + 1]?.[x], grid[y][x - 1], grid[y][x + 1]].some(Boolean)) out[y][x] = OUTLINE
        }
    return fromGrid(out)
}

export function barnSprite(): Sprite {
    const w = 64
    const h = 52
    const c = makeCanvas(w, h)
    const ctx = c.getContext('2d')!
    const px = (x: number, y: number, ww: number, hh: number, col: string) => {
        ctx.fillStyle = col
        ctx.fillRect(x, y, ww, hh)
    }
    // roof (stepped)
    for (let i = 0; i < 16; i++) {
        const inset = 16 - i
        px(4 + inset - 1, i, w - 8 - (inset - 1) * 2, 1, OUTLINE)
        px(4 + inset, i, w - 8 - inset * 2, 1, i % 3 === 0 ? '#7A1F14' : '#9C2B1C')
    }
    px(2, 16, w - 4, 3, OUTLINE)
    px(3, 17, w - 6, 1, '#5E1810')
    // walls
    px(6, 19, w - 12, h - 20, OUTLINE)
    px(7, 19, w - 14, h - 21, '#C0392B')
    for (let x = 10; x < w - 8; x += 4) px(x, 19, 1, h - 21, '#A93226')
    // white trim
    px(7, 19, w - 14, 2, '#F4EDE1')
    // loft window
    px(26, 4, 12, 10, OUTLINE)
    px(27, 5, 10, 8, '#F4EDE1')
    px(28, 6, 8, 6, '#3B2A1A')
    px(31, 6, 2, 6, '#F4EDE1')
    // door
    px(18, 28, 28, h - 29, OUTLINE)
    px(19, 29, 26, h - 30, '#F4EDE1')
    px(21, 31, 22, h - 34, '#8E2A1E')
    for (let i = 0; i < 18; i++) {
        px(21 + Math.round((i * 21) / 17), 31 + i, 2, 1, '#F4EDE1')
        px(41 - Math.round((i * 21) / 17), 31 + i, 2, 1, '#F4EDE1')
    }
    px(31, 29, 2, h - 30, '#F4EDE1')
    // hedgehog sign over the door
    px(24, 21, 16, 6, OUTLINE)
    px(25, 22, 14, 4, '#F7A501')
    px(27, 23, 2, 2, OUTLINE)
    px(31, 23, 2, 2, OUTLINE)
    px(35, 23, 2, 2, OUTLINE)
    return c
}

export function boardSprite(): Sprite {
    return fromMap(
        [
            '..xxxxxxxxxxxxxx..',
            '.xwwwwwwwwwwwwwwx.',
            '.xwpppwyyywbbbwwx.',
            '.xwpppwyyywbbbwwx.',
            '.xwpppwyyywbbbwwx.',
            '.xwwwwwwwwwwwwwwx.',
            '.xwwgggwwrrrrwwwx.',
            '.xwwgggwwrrrrwwwx.',
            '.xwwwwwwwwwwwwwwx.',
            '..xxxxxxxxxxxxxx..',
            '...xbx......xbx...',
            '...xbx......xbx...',
            '...xbx......xbx...',
            '...xbx......xbx...',
            '...xxx......xxx...',
        ],
        { x: OUTLINE, w: '#A0703C', p: '#fff', y: '#FFE066', b: '#9FC4FF', g: '#96E5B6', r: '#FFB4B4' }
    )
}

export function signSprite(): Sprite {
    return fromMap(
        [
            'xxxxxxxxxxxx',
            'xwwwwwwwwwwx',
            'xwkkwkwwkkwx',
            'xwwwwwwwwwwx',
            'xwkwkkkwkwwx',
            'xwwwwwwwwwwx',
            'xxxxxxxxxxxx',
            '.....xbx....',
            '.....xbx....',
            '.....xxx....',
        ],
        { x: OUTLINE, w: '#C89B5E', k: '#6B4A26', b: '#7A4E24' }
    )
}

export function rockSprite(): Sprite {
    return fromMap(['..xxxx..', '.xggGGx.', 'xgggggGx', 'xGgggGGx', '.xxxxxx.'], { x: OUTLINE, g: '#9AA0A6', G: '#C8CDD2' })
}

export function bushSprite(): Sprite {
    return fromMap(
        ['...xxxx...', '.xxgGGgxx.', 'xgggGgggGx', 'xgGggrgggx', 'xggggggGgx', '.xxxxxxxx.'],
        { x: OUTLINE, g: '#3E8E41', G: '#6CC070', r: '#E8384F' }
    )
}

// ---------------------------------------------------------------- avatars

const portraitCache = new Map<string, Promise<Sprite | null>>()
/** Loaded portraits, for synchronous access from the render loop */
const readyPortraits = new Map<string, Sprite | null>()

/** Downsamples an avatar to size×size and posterizes it, for a proper 8-bit portrait */
export function pixelPortrait(url: string | null, size: number): Promise<Sprite | null> {
    if (!url) return Promise.resolve(null)
    const key = `${url}|${size}`
    let p = portraitCache.get(key)
    if (!p) {
        p = new Promise((resolve) => {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => {
                const c = makeCanvas(size, size)
                const ctx = c.getContext('2d', { willReadFrequently: true })!
                ctx.imageSmoothingEnabled = true
                ctx.imageSmoothingQuality = 'high'
                ctx.drawImage(img, 0, 0, size, size)
                try {
                    const data = ctx.getImageData(0, 0, size, size)
                    const d = data.data
                    const levels = size > 20 ? 6 : 5
                    const step = 255 / (levels - 1)
                    for (let i = 0; i < d.length; i += 4) {
                        d[i] = Math.round(d[i] / step) * step
                        d[i + 1] = Math.round(d[i + 1] / step) * step
                        d[i + 2] = Math.round(d[i + 2] / step) * step
                        d[i + 3] = d[i + 3] > 110 ? 255 : 0
                    }
                    ctx.putImageData(data, 0, 0)
                } catch {
                    // tainted canvas: keep the plain downsampled version
                }
                resolve(c)
            }
            // Cloudinary can fail while generating a resize on the fly: fall back to the original upload
            const original = url.replace(/\/image\/upload\/w_[^/]+\//, '/image/upload/')
            img.onerror = () => (img.src !== original ? (img.src = original) : resolve(null))
            img.src = url
        })
        p.then((s) => readyPortraits.set(key, s))
        portraitCache.set(key, p)
    }
    return p
}

/** Synchronous access for the render loop: returns the portrait if it has loaded */
export function portraitIfReady(url: string | null, size: number): Sprite | null | undefined {
    if (!url) return null
    const key = `${url}|${size}`
    if (readyPortraits.has(key)) return readyPortraits.get(key)
    pixelPortrait(url, size) // starts loading if needed
    return undefined
}
