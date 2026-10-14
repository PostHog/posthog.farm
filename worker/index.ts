import { FOOD_BY_ID, type FoodId, ROSTER_BY_ID } from '../shared/game'
import { Barn } from './barn'

export { Barn }

const json = (data: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(data), {
        ...init,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...init.headers },
    })

function barn(env: Env): DurableObjectStub<Barn> {
    return env.BARN.get(env.BARN.idFromName('barn'))
}

/**
 * Who is this farmer? Their IP, hashed with a secret salt so the Barn never stores raw IPs.
 * IPv6 visitors usually get a whole /64 from their ISP, so we key on the /64 — otherwise
 * anyone could get a fresh snack by rotating the last half of their address.
 */
async function visitorId(request: Request, env: Env): Promise<string> {
    const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0'
    const key = ip.includes(':') ? ipv6Prefix(ip) : ip
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.IP_SALT ?? ''}:${key}`))
    return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function ipv6Prefix(ip: string): string {
    const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
    if (mapped) return mapped[1]
    const [head, tail] = ip.split('::')
    const h = head ? head.split(':') : []
    const t = tail ? tail.split(':') : []
    const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
    return `${groups
        .slice(0, 4)
        .map((g) => parseInt(g || '0', 16).toString(16))
        .join(':')}::/64`
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'GET' && path === '/api/farm') {
        // Everyone sees the same farm, so let the edge cache it for a few seconds
        const cache = caches.default
        const cacheKey = new Request(url.origin + '/api/farm')
        const cached = await cache.match(cacheKey)
        if (cached) return cached
        const res = json(await barn(env).getFarm(), { headers: { 'cache-control': 'public, max-age=5' } })
        ctx.waitUntil(cache.put(cacheKey, res.clone()))
        return res
    }

    if (request.method === 'GET' && path === '/api/me') {
        return json(await barn(env).getMe(await visitorId(request, env)))
    }

    const hedgehogMatch = path.match(/^\/api\/hedgehogs\/(\d+)$/)
    if (request.method === 'GET' && hedgehogMatch) {
        const id = Number(hedgehogMatch[1])
        if (!ROSTER_BY_ID.has(id)) return json({ error: 'unknown_hedgehog' }, { status: 404 })
        return json(await barn(env).getHedgehog(id))
    }

    if (request.method === 'POST' && path === '/api/feed') {
        const visitor = await visitorId(request, env)
        const { success } = await env.FEED_LIMITER.limit({ key: visitor })
        if (!success) {
            return json({ ok: false, error: 'slow_down', message: 'Whoa there, speedy farmer. The hedgehogs need a minute.' }, { status: 429 })
        }

        let body: { hedgehogId?: unknown; food?: unknown }
        try {
            body = await request.json()
        } catch {
            return json({ ok: false, error: 'bad_request', message: 'That snack was not valid JSON.' }, { status: 400 })
        }
        const hedgehogId = Number(body.hedgehogId)
        if (!ROSTER_BY_ID.has(hedgehogId)) {
            return json({ ok: false, error: 'unknown_hedgehog', message: 'That hedgehog has left the farm.' }, { status: 404 })
        }
        if (typeof body.food !== 'string' || !FOOD_BY_ID.has(body.food as FoodId)) {
            return json({ ok: false, error: 'unknown_food', message: 'Hedgehogs do not eat that. We checked.' }, { status: 400 })
        }

        const country = (request.cf?.country as string | undefined) ?? null
        const result = await barn(env).feed({ visitor, hedgehogId, food: body.food as FoodId, country })
        return json(result, { status: result.ok ? 200 : result.error === 'already_fed' ? 429 : 400 })
    }

    return json({ error: 'not_found' }, { status: 404 })
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url)
        if (url.hostname.startsWith('www.')) {
            url.hostname = url.hostname.slice(4)
            return Response.redirect(url.toString(), 301)
        }
        if (url.pathname.startsWith('/api/')) {
            try {
                return await handleApi(request, env, ctx)
            } catch (e) {
                console.error(e)
                return json({ ok: false, error: 'barn_on_fire', message: 'The barn is on fire. Please try again.' }, { status: 500 })
            }
        }
        return env.ASSETS.fetch(request)
    },
} satisfies ExportedHandler<Env>
