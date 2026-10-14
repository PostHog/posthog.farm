import { DurableObject } from 'cloudflare:workers'

import {
    type FarmState,
    type FeedEvent,
    type FeedResponse,
    type FoodId,
    type HedgehogDetails,
    type MeState,
    type Outcome,
    type StatTuple,
    ROSTER_BY_ID,
    nextResetAt,
    resolveFeeding,
    utcDay,
} from '../shared/game'

const RECENT_LIMIT = 25
const LOG_RETENTION = 2000

type LogRow = { hedgehog_id: number; food: string; xp: number; outcome: string; country: string | null; created_at: number }

function toEvent(r: LogRow): FeedEvent {
    return {
        hedgehogId: r.hedgehog_id,
        food: r.food as FoodId,
        xp: r.xp,
        outcome: r.outcome as Outcome,
        country: r.country,
        at: r.created_at,
    }
}

/**
 * The Barn. One global instance holds every hedgehog's stats and today's snack locks.
 *
 * A Durable Object handles one request at a time, and SQL inside a single method call
 * runs without interleaving, so "has this visitor fed today? if not, record it" is atomic.
 */
export class Barn extends DurableObject<Env> {
    private sql: SqlStorage

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        this.sql = ctx.storage.sql
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS hedgehogs (
                id INTEGER PRIMARY KEY,
                xp INTEGER NOT NULL DEFAULT 0,
                feeds INTEGER NOT NULL DEFAULT 0,
                last_fed_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS snack_locks (
                day TEXT NOT NULL,
                visitor TEXT NOT NULL,
                hedgehog_id INTEGER NOT NULL,
                food TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (day, visitor)
            );
            CREATE TABLE IF NOT EXISTS feed_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hedgehog_id INTEGER NOT NULL,
                food TEXT NOT NULL,
                xp INTEGER NOT NULL,
                outcome TEXT NOT NULL,
                country TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS feed_log_hedgehog ON feed_log (hedgehog_id, id);
            CREATE TABLE IF NOT EXISTS food_counts (
                hedgehog_id INTEGER NOT NULL,
                food TEXT NOT NULL,
                count INTEGER NOT NULL,
                PRIMARY KEY (hedgehog_id, food)
            );
        `)
    }

    async getFarm(): Promise<FarmState> {
        const now = Date.now()
        const day = utcDay(now)
        const stats: Record<number, StatTuple> = {}
        let feedsAllTime = 0
        for (const r of this.sql.exec<{ id: number; xp: number; feeds: number; last_fed_at: number | null }>(
            'SELECT id, xp, feeds, last_fed_at FROM hedgehogs'
        )) {
            feedsAllTime += r.feeds
            // Hedgehogs that left PostHog keep their row, but disappear from the farm
            if (ROSTER_BY_ID.has(r.id)) stats[r.id] = [r.xp, r.feeds, r.last_fed_at]
        }
        const recent = this.sql
            .exec<LogRow>('SELECT * FROM feed_log ORDER BY id DESC LIMIT ?', RECENT_LIMIT * 2)
            .toArray()
            .filter((r) => ROSTER_BY_ID.has(r.hedgehog_id))
            .slice(0, RECENT_LIMIT)
            .map(toEvent)
        const feedsToday = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM snack_locks WHERE day = ?', day).one().n
        return { day, now, nextResetAt: nextResetAt(now), stats, recent, feedsToday, feedsAllTime }
    }

    async getMe(visitor: string): Promise<MeState> {
        const now = Date.now()
        const day = utcDay(now)
        return { day, nextResetAt: nextResetAt(now), fed: this.lockFor(day, visitor) }
    }

    async getHedgehog(id: number): Promise<HedgehogDetails> {
        const row = this.sql
            .exec<{ xp: number; feeds: number; last_fed_at: number | null }>('SELECT xp, feeds, last_fed_at FROM hedgehogs WHERE id = ?', id)
            .toArray()[0]
        const foods: HedgehogDetails['foods'] = {}
        for (const r of this.sql.exec<{ food: string; count: number }>('SELECT food, count FROM food_counts WHERE hedgehog_id = ?', id)) {
            foods[r.food as FoodId] = r.count
        }
        const countries = this.sql
            .exec<{ country: string; count: number }>(
                `SELECT country, COUNT(*) AS count FROM feed_log
                 WHERE hedgehog_id = ? AND country IS NOT NULL
                 GROUP BY country ORDER BY count DESC LIMIT 5`,
                id
            )
            .toArray()
        const recent = this.sql.exec<LogRow>('SELECT * FROM feed_log WHERE hedgehog_id = ? ORDER BY id DESC LIMIT 6', id).toArray().map(toEvent)
        return { stats: row ? [row.xp, row.feeds, row.last_fed_at] : [0, 0, null], foods, countries, recent }
    }

    async feed(opts: { visitor: string; hedgehogId: number; food: FoodId; country: string | null }): Promise<FeedResponse> {
        const now = Date.now()
        const day = utcDay(now)
        const hedgehog = ROSTER_BY_ID.get(opts.hedgehogId)
        if (!hedgehog) return { ok: false, error: 'unknown_hedgehog', message: 'That hedgehog has left the farm.' }

        const existing = this.lockFor(day, opts.visitor)
        if (existing) {
            return {
                ok: false,
                error: 'already_fed',
                message: 'The Hedgehog Nutrition Council allows one snack per farmer per day.',
                nextResetAt: nextResetAt(now),
                fed: existing,
            }
        }

        const current = this.sql
            .exec<{ xp: number; feeds: number; last_fed_at: number | null }>('SELECT xp, feeds, last_fed_at FROM hedgehogs WHERE id = ?', hedgehog.id)
            .toArray()[0] ?? { xp: 0, feeds: 0, last_fed_at: null }
        const { xp, outcome, multipliers } = resolveFeeding({
            food: opts.food,
            hedgehog,
            day,
            lastFedAt: current.last_fed_at,
            now,
        })

        this.ctx.storage.transactionSync(() => {
            this.sql.exec(
                'INSERT INTO snack_locks (day, visitor, hedgehog_id, food, created_at) VALUES (?, ?, ?, ?, ?)',
                day,
                opts.visitor,
                hedgehog.id,
                opts.food,
                now
            )
            this.sql.exec(
                `INSERT INTO hedgehogs (id, xp, feeds, last_fed_at) VALUES (?, ?, 1, ?)
                 ON CONFLICT (id) DO UPDATE SET xp = xp + excluded.xp, feeds = feeds + 1, last_fed_at = excluded.last_fed_at`,
                hedgehog.id,
                xp,
                now
            )
            this.sql.exec(
                `INSERT INTO food_counts (hedgehog_id, food, count) VALUES (?, ?, 1)
                 ON CONFLICT (hedgehog_id, food) DO UPDATE SET count = count + 1`,
                hedgehog.id,
                opts.food
            )
            this.sql.exec(
                'INSERT INTO feed_log (hedgehog_id, food, xp, outcome, country, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                hedgehog.id,
                opts.food,
                xp,
                outcome,
                opts.country,
                now
            )
            // Housekeeping: yesterday's locks are useless, and the log only needs a tail
            this.sql.exec('DELETE FROM snack_locks WHERE day < ?', day)
            this.sql.exec('DELETE FROM feed_log WHERE id <= (SELECT MAX(id) FROM feed_log) - ?', LOG_RETENTION)
        })

        return {
            ok: true,
            event: { hedgehogId: hedgehog.id, food: opts.food, xp, outcome, country: opts.country, at: now },
            stats: [current.xp + xp, current.feeds + 1, now],
            multipliers,
        }
    }

    private lockFor(day: string, visitor: string): MeState['fed'] {
        const row = this.sql
            .exec<{ hedgehog_id: number; food: string; created_at: number }>(
                'SELECT hedgehog_id, food, created_at FROM snack_locks WHERE day = ? AND visitor = ?',
                day,
                visitor
            )
            .toArray()[0]
        return row ? { hedgehogId: row.hedgehog_id, food: row.food as FoodId, at: row.created_at } : null
    }
}
