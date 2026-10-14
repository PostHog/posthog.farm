// Product analytics through posthog-js, into posthog.com's project, set up like brand.posthog.com.
//
// Pageviews and clicks on the HUD come from the SDK itself. The game is a canvas, so the moments
// that matter (feeding, trophies, opening a hedgehog's card…) are captured explicitly. Trophies
// and streaks only live in the browser, so these events are the only record of them.
// No session replay.

import posthog from 'posthog-js'

import type { Hedgehog } from '../shared/game'

/** posthog.com's project. A public, write-only token: safe to ship in the bundle. */
const POSTHOG_KEY = 'sTMFPsFhdP1Ssg'
const POSTHOG_HOST = 'https://us.i.posthog.com'

export function initAnalytics(): void {
    posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        defaults: '2026-08-30',
        person_profiles: 'always',
        // Local clicking around stays out of the real project.
        opt_out_capturing_by_default: import.meta.env.DEV,
        disable_session_recording: true,
        // This is posthog.com's project: its surveys, support widget and product tours are
        // meant for posthog.com, not for the farm.
        disable_surveys: true,
        disable_conversations: true,
        disable_product_tours: true,
    })
    // The project has several sites in it; this makes the farm's events easy to filter.
    posthog.register({ site: 'posthog.farm' })
}

/** A hedgehog's identity, as every hedgehog event describes it. */
export function hedgehogProperties(h: Hedgehog) {
    return { hedgehog_id: h.id, hedgehog_name: h.name, hedgehog_team: h.teams[0], hedgehog_teams: h.teams }
}

export function track(event: string, properties?: Record<string, unknown>): void {
    posthog.capture(event, properties)
}
