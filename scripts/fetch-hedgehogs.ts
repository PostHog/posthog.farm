// Fetches the current PostHog team from the same Squeak (Strapi) API that posthog.com
// uses to build its /people page, and writes it to shared/roster.json.
//
// Same rules as posthog.com (plugins/gatsby-source-squeak + src/components/People):
//   - startDate is set and is today or earlier
//   - belongs to at least one team (people who left get removed from their teams)
//   - excludes profile 28378 ("PostHog AI", not a real hedgehog)
//
// Runs on every build, so the daily rebuild adds new hedgehogs and removes old ones.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const API_HOST = process.env.SQUEAK_API_HOST || 'https://better-animal-d658c56969.strapiapp.com'
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../shared/roster.json')
const EXCLUDED_IDS = new Set([28378])
const MIN_EXPECTED = 50 // refuse to deploy a suspiciously empty farm

// Hex values of the profile colors from posthog.com's tailwind config
const COLORS: Record<string, string> = {
    'lime-green': '#96E5B6',
    blue: '#2F80FA',
    orange: '#EB9D2A',
    teal: '#29DBBB',
    purple: '#B62AD9',
    seagreen: '#30ABC6',
    salmon: '#F35454',
    yellow: '#F7A501',
    red: '#F54E00',
    green: '#6AA84F',
    lilac: '#8567FF',
    'sky-blue': '#2EA2D3',
}
const FALLBACK_COLORS = Object.values(COLORS)

if (process.argv.includes('--if-missing') && existsSync(OUT)) {
    console.log('🦔 shared/roster.json already exists, skipping fetch (run `npm run fetch:hedgehogs` to refresh)')
    process.exit(0)
}

const today = new Date().toISOString().slice(0, 10)

function profileQuery(page: number): string {
    const p = new URLSearchParams()
    p.set('filters[$and][0][startDate][$notNull]', 'true')
    p.set('filters[$and][1][startDate][$lte]', today)
    p.set('filters[$and][2][teams][id][$notNull]', 'true')
    p.set('pagination[page]', String(page))
    p.set('pagination[pageSize]', '100')
    p.set('sort[0]', 'startDate:asc')
    const fields = [
        'firstName',
        'lastName',
        'companyRole',
        'country',
        'location',
        'color',
        'pineappleOnPizza',
        'startDate',
        'biography',
        'pronouns',
        'height',
    ]
    fields.forEach((f, i) => p.set(`fields[${i}]`, f))
    p.set('populate[avatar][fields][0]', 'url')
    p.set('populate[teams][fields][0]', 'name')
    p.set('populate[leadTeams][fields][0]', 'name')
    return p.toString()
}

// Cloudinary can resize on the fly, which gives us cheap, tiny avatars to pixelate
function cloudinary(url: string, size: number): string {
    if (!url.includes('res.cloudinary.com') || !url.includes('/image/upload/')) return url
    return url.replace('/image/upload/', `/image/upload/w_${size},h_${size},c_fill,g_face,f_png/`)
}

function plainText(markdown: string | null | undefined, max: number): string {
    const text = (markdown || '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links
        .replace(/<[^>]+>/g, '') // html
        .replace(/[#*_`>~]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    if (text.length <= max) return text
    const cut = text.slice(0, max)
    return cut.slice(0, cut.lastIndexOf(' ')) + '…'
}

function hashString(s: string): number {
    let h = 2166136261
    for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
    return h >>> 0
}

type Rel = { data: { id: number; attributes: { name?: string; url?: string } }[] | null }

async function fetchPage(page: number) {
    const url = `${API_HOST}/api/profiles?${profileQuery(page)}`
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(url)
        if (res.ok) return res.json()
        if (attempt >= 3) throw new Error(`Squeak API ${res.status} for page ${page}: ${await res.text()}`)
        await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
}

const hedgehogs = []
for (let page = 1; ; page++) {
    const json = await fetchPage(page)
    for (const { id, attributes: a } of json.data) {
        if (EXCLUDED_IDS.has(id)) continue
        const avatarUrl: string | undefined = (a.avatar as { data?: { attributes?: { url?: string } } })?.data?.attributes?.url
        const teams = ((a.teams as Rel)?.data || []).map((t) => t.attributes.name).filter(Boolean) as string[]
        if (!teams.length) continue
        const name = [a.firstName, a.lastName].filter(Boolean).join(' ').trim()
        if (!name) continue
        hedgehogs.push({
            id,
            firstName: (a.firstName || name).trim(),
            name,
            role: a.companyRole || 'Hedgehog',
            teams,
            leadTeams: ((a.leadTeams as Rel)?.data || []).map((t) => t.attributes.name).filter(Boolean),
            country: a.country || null,
            location: a.location || null,
            color: COLORS[a.color] || FALLBACK_COLORS[hashString(name) % FALLBACK_COLORS.length],
            pineapple: typeof a.pineappleOnPizza === 'boolean' ? a.pineappleOnPizza : null,
            startDate: a.startDate,
            pronouns: a.pronouns || null,
            heightCm: a.height ? Math.round(a.height * 2.54) : null,
            bio: plainText(a.biography, 220),
            avatar: avatarUrl ? cloudinary(avatarUrl, 32) : null,
            avatarLarge: avatarUrl ? cloudinary(avatarUrl, 160) : null,
        })
    }
    if (json.meta.pagination.page >= json.meta.pagination.pageCount) break
}

if (hedgehogs.length < MIN_EXPECTED) {
    console.error(`🦔 Only found ${hedgehogs.length} hedgehogs, expected at least ${MIN_EXPECTED}. Refusing to write.`)
    process.exit(1)
}

hedgehogs.sort((a, b) => a.id - b.id)
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), hedgehogs }, null, 1))
console.log(`🦔 Wrote ${hedgehogs.length} hedgehogs to shared/roster.json`)
