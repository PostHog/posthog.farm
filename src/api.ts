import type { FarmState, FeedResponse, FoodId, HedgehogDetails, MeState } from '../shared/game'

async function get<T>(path: string): Promise<T> {
    const res = await fetch(path)
    if (!res.ok) throw new Error(`${path}: ${res.status}`)
    return res.json()
}

export const api = {
    farm: () => get<FarmState>('/api/farm'),
    me: () => get<MeState>('/api/me'),
    hedgehog: (id: number) => get<HedgehogDetails>(`/api/hedgehogs/${id}`),
    async feed(hedgehogId: number, food: FoodId): Promise<FeedResponse> {
        try {
            const res = await fetch('/api/feed', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ hedgehogId, food }),
            })
            return await res.json()
        } catch {
            return { ok: false, error: 'bad_request', message: 'The carrier pigeon got lost. Check your connection and try again.' }
        }
    },
}
