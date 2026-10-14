// The farmer's local progress. Snack limits live on the server; this is just for fun.

import { DAY_MS, type FoodId, utcDay } from '../shared/game'

export type Trophy = { id: string; name: string; desc: string }

export const TROPHIES: Trophy[] = [
    { id: 'first_snack', name: 'FIRST SNACK', desc: 'Fed your very first hedgehog.' },
    { id: 'streak_3', name: 'CREATURE OF HABIT', desc: 'Fed a hedgehog 3 days in a row.' },
    { id: 'streak_7', name: 'HEDGEHOG WHISPERER', desc: '7 day feeding streak.' },
    { id: 'streak_30', name: 'FARMER OF THE MONTH', desc: '30 day streak. Touch grass? You ARE the grass.' },
    { id: 'pizza_love', name: 'PERSON OF CULTURE', desc: 'Fed pineapple pizza to a believer.' },
    { id: 'pizza_hate', name: 'DIPLOMATIC INCIDENT', desc: 'Fed pineapple pizza to a hater. On purpose?' },
    { id: 'zoomies', name: 'ZOOMIES', desc: 'Caffeinated a hedgehog. They can see sounds now.' },
    { id: 'flag_off', name: 'CONTROL GROUP', desc: 'Your feature flag evaluated to false.' },
    { id: 'flag_on', name: 'ROLLED OUT', desc: 'Your feature flag evaluated to true.' },
    { id: 'sock', name: 'IT WAS A SOCK', desc: 'Opened a mystery box. It was a sock.' },
    { id: 'gold', name: 'LEGENDARY DROP', desc: 'Found a golden mealworm in a mystery box.' },
    { id: 'water', name: 'HYDRATION STATION', desc: 'Served sparkling water. Truly the worst snack.' },
    { id: 'rescue', name: 'RESCUE MISSION', desc: 'Fed a starving hedgehog.' },
    { id: 'hogiversary', name: 'PARTY HOG', desc: 'Fed a hedgehog on their hogiversary.' },
    { id: 'founder', name: 'EXECUTIVE SNACK', desc: 'Fed a co-founder. Big career move.' },
    { id: 'night_owl', name: 'NOCTURNAL', desc: 'Fed a hedgehog between midnight and 5am. Hedgehogs respect this.' },
    { id: 'whistle', name: 'WHISTLEBLOWER', desc: 'Whistled a hedgehog over.' },
    { id: 'meet_25', name: 'SOCIAL BUTTERFLY', desc: 'Met 25 hedgehogs.' },
    { id: 'meet_100', name: 'NETWORKING EVENT', desc: 'Met 100 hedgehogs.' },
    { id: 'meet_all', name: "GOTTA MEET 'EM ALL", desc: 'Met every single hedgehog on the farm.' },
    { id: 'pond', name: 'REFLECTIVE', desc: 'Stared into the pond. The pond stared back.' },
]

type SaveData = {
    seen: number[]
    fed: { day: string; hedgehogId: number; food: FoodId }[]
    streak: number
    lastFedDay: string | null
    trophies: string[]
    sfx: boolean
    music: boolean
    names: boolean
    lastFood: FoodId
    introSeen: boolean
}

const KEY = 'posthog-farm-save-v1'

function load(): SaveData {
    const defaults: SaveData = {
        seen: [],
        fed: [],
        streak: 0,
        lastFedDay: null,
        trophies: [],
        sfx: true,
        music: true,
        names: false,
        lastFood: 'mealworm',
        introSeen: false,
    }
    try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
    } catch {
        return defaults
    }
}

export const save = load()
const seenSet = new Set(save.seen)

export function persist() {
    save.seen = [...seenSet]
    localStorage.setItem(KEY, JSON.stringify(save))
}

/** Returns true if this is the first time we meet them */
export function markSeen(id: number): boolean {
    if (seenSet.has(id)) return false
    seenSet.add(id)
    persist()
    return true
}

export const seenCount = () => seenSet.size
export const hasSeen = (id: number) => seenSet.has(id)

/** Returns trophy if newly unlocked */
export function unlock(id: string): Trophy | null {
    if (save.trophies.includes(id)) return null
    save.trophies.push(id)
    persist()
    return TROPHIES.find((t) => t.id === id) ?? null
}

export function currentStreak(now = Date.now()): number {
    if (!save.lastFedDay) return 0
    const today = utcDay(now)
    const yesterday = utcDay(now - DAY_MS)
    return save.lastFedDay === today || save.lastFedDay === yesterday ? save.streak : 0
}

export function recordFeed(hedgehogId: number, food: FoodId, now = Date.now()) {
    const today = utcDay(now)
    if (save.lastFedDay === today) return
    save.streak = save.lastFedDay === utcDay(now - DAY_MS) ? save.streak + 1 : 1
    save.lastFedDay = today
    save.fed.push({ day: today, hedgehogId, food })
    save.lastFood = food
    persist()
}
