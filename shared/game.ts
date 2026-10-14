// Game rules shared by the Worker (authoritative) and the browser (for display).

import rosterData from './roster.json'

export type Hedgehog = {
    id: number
    firstName: string
    /** what the game calls them: first name, plus last initial when the first name is shared (Ben H, Ben V) */
    shortName: string
    name: string
    role: string
    teams: string[]
    leadTeams: string[]
    country: string | null
    location: string | null
    color: string
    pineapple: boolean | null
    startDate: string
    pronouns: string | null
    heightCm: number | null
    bio: string
    avatar: string | null
    avatarLarge: string | null
}

type RosterEntry = Omit<Hedgehog, 'shortName'>

// Letters that are their own character rather than a base letter + accent, so NFD can't strip them
const LETTER_FOLDS: Record<string, string> = { ł: 'l', ø: 'o', đ: 'd', ð: 'd', ß: 'ss', æ: 'ae', œ: 'oe', ı: 'i', þ: 'th' }

/** "Paweł" and "Pawel" are the same name as far as telling hedgehogs apart goes */
const normalizeName = (name: string) =>
    name
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[łøđðßæœıþ]/g, (c) => LETTER_FOLDS[c])

const firstNameCounts = new Map<string, number>()
for (const h of rosterData.hedgehogs as RosterEntry[]) {
    const key = normalizeName(h.firstName)
    firstNameCounts.set(key, (firstNameCounts.get(key) ?? 0) + 1)
}

function shortName(h: RosterEntry): string {
    if ((firstNameCounts.get(normalizeName(h.firstName)) ?? 0) < 2) return h.firstName
    const rest = h.name.startsWith(h.firstName) ? h.name.slice(h.firstName.length) : h.name.split(' ').slice(1).join(' ')
    const initial = rest.trim().charAt(0).toUpperCase()
    return initial ? `${h.firstName} ${initial}` : h.firstName
}

export const ROSTER: Hedgehog[] = (rosterData.hedgehogs as RosterEntry[]).map((h) => ({ ...h, shortName: shortName(h) }))
export const ROSTER_GENERATED_AT: string = rosterData.generatedAt
export const ROSTER_BY_ID = new Map(ROSTER.map((h) => [h.id, h]))

/** [xp, feeds, lastFedAt (ms) | null] — compact because we send all of them on every poll */
export type StatTuple = [number, number, number | null]

export type FeedEvent = {
    hedgehogId: number
    food: FoodId
    xp: number
    outcome: Outcome
    country: string | null
    at: number
}

export type FarmState = {
    day: string
    now: number
    nextResetAt: number
    stats: Record<number, StatTuple>
    recent: FeedEvent[]
    feedsToday: number
    feedsAllTime: number
}

export type MeState = {
    day: string
    nextResetAt: number
    fed: { hedgehogId: number; food: FoodId; at: number } | null
}

export type HedgehogDetails = {
    stats: StatTuple
    foods: Partial<Record<FoodId, number>>
    countries: { country: string; count: number }[]
    recent: FeedEvent[]
}

export type FeedResponse =
    | { ok: true; event: FeedEvent; stats: StatTuple; multipliers: string[] }
    | {
          ok: false
          error: 'already_fed' | 'unknown_hedgehog' | 'unknown_food' | 'slow_down' | 'bad_request'
          message: string
          nextResetAt?: number
          fed?: MeState['fed']
      }

// ---------------------------------------------------------------- time

export const DAY_MS = 24 * 60 * 60 * 1000

export function utcDay(now = Date.now()): string {
    return new Date(now).toISOString().slice(0, 10)
}

export function nextResetAt(now = Date.now()): number {
    return Math.floor(now / DAY_MS) * DAY_MS + DAY_MS
}

export function isHogiversary(h: Hedgehog, day: string): boolean {
    return h.startDate.slice(5) === day.slice(5) && h.startDate.slice(0, 4) !== day.slice(0, 4)
}

/** Everyone celebrating a PostHog work anniversary on this (UTC) day */
export function hogiversariesOn(day: string): Hedgehog[] {
    return ROSTER.filter((h) => isHogiversary(h, day))
}

/** The next day (after `day`) with at least one hogiversary, for the "none today" banner */
export function nextHogiversary(day: string): { day: string; hedgehogs: Hedgehog[] } | null {
    const start = Date.parse(`${day}T00:00:00Z`)
    for (let i = 1; i <= 366; i++) {
        const d = utcDay(start + i * DAY_MS)
        const hedgehogs = hogiversariesOn(d)
        if (hedgehogs.length) return { day: d, hedgehogs }
    }
    return null
}

export function yearsAtPostHog(h: Hedgehog, day: string): number {
    return Number(day.slice(0, 4)) - Number(h.startDate.slice(0, 4))
}

export function isNewbie(h: Hedgehog, now = Date.now()): boolean {
    return now - Date.parse(h.startDate) < 45 * DAY_MS
}

// ---------------------------------------------------------------- levels

export function xpForLevel(level: number): number {
    return 20 * (level - 1) ** 2
}

export function levelForXp(xp: number): number {
    return Math.floor(Math.sqrt(Math.max(0, xp) / 20)) + 1
}

export const CHONK_STAGES = ['SMOL BEAN', 'ROUND BOI', 'CHONK', 'ABSOLUTE UNIT', 'OH LAWD THEY COMIN'] as const

export function chonkStage(level: number): number {
    if (level >= 10) return 4
    if (level >= 7) return 3
    if (level >= 4) return 2
    if (level >= 2) return 1
    return 0
}

// ---------------------------------------------------------------- hunger

export const HUNGER = [
    { label: 'STUFFED', hours: 12 },
    { label: 'CONTENT', hours: 24 },
    { label: 'PECKISH', hours: 48 },
    { label: 'HUNGRY', hours: 96 },
    { label: 'STARVING', hours: Infinity },
] as const

/** 0 = stuffed … 4 = starving */
export function hungerLevel(lastFedAt: number | null, now = Date.now()): number {
    if (!lastFedAt) return 4
    const hours = (now - lastFedAt) / 3_600_000
    return HUNGER.findIndex((h) => hours < h.hours)
}

/** 0..1 how full the belly is, for the hunger bar */
export function fullness(lastFedAt: number | null, now = Date.now()): number {
    if (!lastFedAt) return 0
    return Math.max(0, 1 - (now - lastFedAt) / (96 * 3_600_000))
}

// ---------------------------------------------------------------- food

export type FoodId = 'mealworm' | 'strawberry' | 'catfood' | 'pizza' | 'coffee' | 'flag' | 'water' | 'mystery'

export type Outcome =
    | 'nom'
    | 'pizza_love'
    | 'pizza_hate'
    | 'pizza_meh'
    | 'zoomies'
    | 'flag_on'
    | 'flag_off'
    | 'water'
    | 'mystery_gold'
    | 'mystery_sock'
    | 'mystery_snack'

export type Food = { id: FoodId; name: string; blurb: string; xp: string }

export const FOODS: Food[] = [
    { id: 'mealworm', name: 'MEALWORM', xp: '+10', blurb: 'The classic. Crunchy. Protein-forward. Hedgehog approved.' },
    { id: 'strawberry', name: 'STRAWBERRY', xp: '+8', blurb: "Nature's candy. A treat, in moderation. Like meetings." },
    { id: 'catfood', name: 'CAT FOOD', xp: '+12', blurb: "Liberated from the office cat. Don't make eye contact with it." },
    {
        id: 'pizza',
        name: 'PINEAPPLE PIZZA',
        xp: '+2..+25',
        blurb: 'The most divisive food in the company. Check their stance first. Or don\'t. Chaos is a feature.',
    },
    { id: 'coffee', name: 'HOGPUCCINO', xp: '+6', blurb: 'Triple shot. Side effects include zoomies, shipping, and vibrating.' },
    { id: 'flag', name: 'FEATURE FLAG', xp: '0 or +30', blurb: 'Rolled out to 50% of hedgehogs. Results may vary. Very on brand.' },
    { id: 'water', name: 'SPARKLING WATER', xp: '+1', blurb: "It's just water that's been through a lot. Zero calories. Zero joy." },
    { id: 'mystery', name: 'MYSTERY BOX', xp: '???', blurb: 'Found behind the barn. Smells like... potential. Possibly socks.' },
]

export const FOOD_BY_ID = new Map(FOODS.map((f) => [f.id, f]))

/** Server-side: decides what happens. `random` is injectable so it can be tested. */
export function resolveFeeding(opts: {
    food: FoodId
    hedgehog: Hedgehog
    day: string
    lastFedAt: number | null
    now: number
    random?: () => number
}): { xp: number; outcome: Outcome; multipliers: string[] } {
    const random = opts.random ?? Math.random
    let xp = 0
    let outcome: Outcome = 'nom'
    switch (opts.food) {
        case 'mealworm':
            xp = 10
            break
        case 'strawberry':
            xp = 8
            break
        case 'catfood':
            xp = 12
            break
        case 'pizza':
            if (opts.hedgehog.pineapple === true) [xp, outcome] = [25, 'pizza_love']
            else if (opts.hedgehog.pineapple === false) [xp, outcome] = [2, 'pizza_hate']
            else [xp, outcome] = [10, 'pizza_meh']
            break
        case 'coffee':
            ;[xp, outcome] = [6, 'zoomies']
            break
        case 'flag':
            ;[xp, outcome] = random() < 0.5 ? [30, 'flag_on'] : [0, 'flag_off']
            break
        case 'water':
            ;[xp, outcome] = [1, 'water']
            break
        case 'mystery': {
            const r = random()
            if (r < 0.1) [xp, outcome] = [50, 'mystery_gold']
            else if (r < 0.4) [xp, outcome] = [0, 'mystery_sock']
            else [xp, outcome] = [5 + Math.floor(random() * 16), 'mystery_snack']
            break
        }
    }

    const multipliers: string[] = []
    if (xp > 0) {
        if (isHogiversary(opts.hedgehog, opts.day)) {
            xp = Math.round(xp * 1.5)
            multipliers.push('HOGIVERSARY x1.5')
        }
        if (hungerLevel(opts.lastFedAt, opts.now) === 4) {
            xp = Math.round(xp * 1.5)
            multipliers.push('RESCUE SNACK x1.5')
        }
    }
    return { xp, outcome, multipliers }
}
