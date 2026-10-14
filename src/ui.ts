import {
    CHONK_STAGES,
    FOOD_BY_ID,
    FOODS,
    type FeedEvent,
    type FoodId,
    HUNGER,
    type Hedgehog,
    ROSTER,
    ROSTER_BY_ID,
    chonkStage,
    fullness,
    hogiversariesOn,
    hungerLevel,
    isHogiversary,
    isNewbie,
    levelForXp,
    nextHogiversary,
    xpForLevel,
    yearsAtPostHog,
} from '../shared/game'
import { hedgehogProperties, track } from './analytics'
import { api } from './api'
import { audio } from './audio'
import { article, flag, fmtCountdown, fmtNumber, h, timeAgo } from './dom'
import { OUTCOME_TITLES, pick } from './lines'
import { TROPHIES, currentStreak, hasSeen, markSeen, persist, recordFeed, save, seenCount, unlock } from './save'
import * as S from './sprites'
import { serverNow, state } from './state'
import type { Hog, PropAction } from './world'

const HUNGER_COLORS = ['#36C46F', '#96E5B6', '#F7A501', '#F87A4C', '#F54E00']

// ---------------------------------------------------------------- modal plumbing

const modalRoot = () => document.getElementById('modal-root')!
let onModalClose: (() => void) | null = null
let currentModal: string | null = null

export function openModal(id: string, title: string, body: HTMLElement, opts: { wide?: boolean; accent?: string } = {}) {
    closeModal(true)
    currentModal = id
    state.world.paused = true
    audio.play('open')
    const win = h(
        'div',
        { class: `window ${opts.wide ? 'wide' : ''}`, role: 'dialog', 'aria-label': title, style: opts.accent ? { '--accent': opts.accent } : undefined },
        h('div', { class: 'window-title' }, h('span', {}, title), h('button', { class: 'close', onclick: () => closeModal(), 'aria-label': 'Close' }, 'X')),
        h('div', { class: 'window-body' }, body)
    )
    const backdrop = h('div', { class: 'backdrop', onclick: (e: MouseEvent) => e.target === backdrop && closeModal() }, win)
    modalRoot().replaceChildren(backdrop)
}

export function closeModal(silent = false) {
    if (!currentModal) return
    currentModal = null
    modalRoot().replaceChildren()
    state.world.paused = false
    onModalClose?.()
    onModalClose = null
    if (!silent) audio.play('close')
}

export const isModalOpen = () => currentModal !== null
export const isTyping = () => document.activeElement?.tagName === 'INPUT'

// ---------------------------------------------------------------- toasts

export function toast(title: string, text = '', kind: 'info' | 'trophy' | 'error' | 'win' = 'info', ms = 4200) {
    const el = h('div', { class: `toast toast-${kind}` }, h('strong', {}, title), text ? h('span', {}, text) : null)
    const root = document.getElementById('toasts')!
    root.append(el)
    // never bury the farm under a pile of toasts
    while (root.children.length > 3) root.firstElementChild!.remove()
    setTimeout(() => el.classList.add('out'), ms)
    setTimeout(() => el.remove(), ms + 400)
}

export function award(id: string) {
    const t = unlock(id)
    if (!t) return
    track('trophy unlocked', {
        trophy_id: t.id,
        trophy_name: t.name,
        trophies_unlocked: save.trophies.length,
        trophies_total: TROPHIES.length,
        all_trophies_unlocked: save.trophies.length >= TROPHIES.length,
    })
    trophyQueue.push(t)
    if (trophyQueue.length === 1) setTimeout(drainTrophies, trophyDelay)
}

let trophyDelay = 400
const trophyQueue: { name: string; desc: string }[] = []
function drainTrophies() {
    const t = trophyQueue.shift()
    if (!t) return
    audio.play('trophy')
    toast(`🏆 TROPHY: ${t.name}`, t.desc, 'trophy', 4500)
    if (trophyQueue.length) setTimeout(drainTrophies, 1600)
}

// ---------------------------------------------------------------- shared bits

function portrait(hedgehog: Hedgehog, size: number, cls = 'portrait', large = false): HTMLCanvasElement {
    const c = h('canvas', { class: cls, width: size, height: size })
    S.pixelPortrait(large ? hedgehog.avatarLarge : hedgehog.avatar, size).then((s) => {
        const ctx = c.getContext('2d')!
        if (s) ctx.drawImage(s, 0, 0)
        else {
            const hog = S.hedgehogSprite(hedgehog.color, 2, 'walk0')
            ctx.drawImage(hog, (size - hog.width) / 2, (size - hog.height) / 2)
        }
    })
    return c
}

function foodIcon(id: FoodId, scale = 4): HTMLCanvasElement {
    const s = S.foodSprite(id)
    const c = h('canvas', { class: 'food-icon', width: s.width, height: s.height, style: { width: `${s.width * scale}px`, height: `${s.height * scale}px` } })
    c.getContext('2d')!.drawImage(s, 0, 0)
    return c
}

function bar(value: number, color: string, label?: string) {
    return h(
        'div',
        { class: 'bar' },
        h('div', { class: 'bar-fill', style: { width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`, background: color } }),
        label ? h('span', { class: 'bar-label' }, label) : null
    )
}

function statsOf(id: number) {
    const hog = state.world.hogById.get(id)
    const [xp, feeds, lastFedAt] = hog?.stats ?? [0, 0, null]
    const level = levelForXp(xp)
    return { xp, feeds, lastFedAt, level, stage: chonkStage(level), hunger: hungerLevel(lastFedAt, serverNow()) }
}

export function findHog(hog: Hog) {
    track('hedgehog tracked', hedgehogProperties(hog.h))
    closeModal(true)
    state.world.focusOn(hog)
    toast(`TRACKING ${hog.h.shortName.toUpperCase()}`, 'Follow the yellow arrow around your farmer. Or whistle and let them come to you.')
}

export function whistleHog(hog: Hog) {
    track('hedgehog whistled', hedgehogProperties(hog.h))
    closeModal(true)
    state.world.whistle(hog)
    award('whistle')
    toast(`*WHISTLES*`, `${hog.h.shortName} is waddling over as fast as their little legs allow.`)
}

// ---------------------------------------------------------------- hedgehog card

/** `source`: where the card was opened from, e.g. walking up to them on the farm or the Hedgedex */
export function openHedgehog(hog: Hog, source: 'farm' | 'dex' | 'ranks' = 'farm') {
    const hh = hog.h
    track('hedgehog card opened', { ...hedgehogProperties(hh), source })
    if (markSeen(hh.id)) checkMeetTrophies()
    const s = statsOf(hh.id)
    const farm = state.farm
    const day = farm?.day ?? new Date().toISOString().slice(0, 10)
    const joined = new Date(hh.startDate + 'T00:00:00Z')
    const daysAtPostHog = Math.floor((serverNow() - joined.getTime()) / 86_400_000)
    const nextLevelXp = xpForLevel(s.level + 1)
    const levelXp = xpForLevel(s.level)

    const badges = h(
        'div',
        { class: 'badges' },
        isHogiversary(hh, day) ? h('span', { class: 'badge party' }, `🎉 ${yearsAtPostHog(hh, day)}-YEAR HOGIVERSARY · 1.5X XP`) : null,
        isNewbie(hh, serverNow()) ? h('span', { class: 'badge new' }, 'NEW HOG') : null,
        s.hunger === 4 ? h('span', { class: 'badge hungry' }, 'STARVING · 1.5X XP') : null,
        hh.leadTeams.length ? h('span', { class: 'badge lead' }, `TEAM LEAD`) : null
    )

    const favFood = h('span', {}, '...')
    const fans = h('span', {}, '...')
    const recent = h('ul', { class: 'mini-log' }, h('li', {}, 'Loading snack history...'))
    api.hedgehog(hh.id)
        .then((d) => {
            const fav = Object.entries(d.foods).sort((a, b) => b[1] - a[1])[0]
            favFood.textContent = fav ? `${FOOD_BY_ID.get(fav[0] as FoodId)!.name} (${fav[1]}x)` : 'UNKNOWN (never fed!)'
            fans.textContent = d.countries.length ? d.countries.map((c) => `${flag(c.country)} ${c.country}`).join('  ') : 'NONE YET'
            recent.replaceChildren(
                ...(d.recent.length
                    ? d.recent.map((e) => h('li', {}, `${flag(e.country)} ${FOOD_BY_ID.get(e.food)!.name} · +${e.xp} XP · ${timeAgo(e.at, serverNow())}`))
                    : [h('li', {}, 'No snacks yet. Be the first!')])
            )
        })
        .catch(() => recent.replaceChildren(h('li', {}, 'The snack ledger is unavailable.')))

    const pineapple = hh.pineapple === true ? 'YES 🍍 (a person of culture)' : hh.pineapple === false ? 'NO 🚫 (strongly against)' : 'UNDECIDED 🤷'
    const body = h(
        'div',
        { class: 'card' },
        h(
            'div',
            { class: 'card-top' },
            h(
                'div',
                { class: 'card-left' },
                h('div', { class: 'portrait-frame', style: { '--c': hh.color } }, portrait(hh, 40, 'portrait big', true)),
                h(
                    'div',
                    { class: 'hog-preview' },
                    (() => {
                        const sp = S.hedgehogSprite(hh.color, s.stage, 'walk0')
                        const c = h('canvas', { width: sp.width, height: sp.height, style: { width: `${sp.width * 4}px`, height: `${sp.height * 4}px` } })
                        c.getContext('2d')!.drawImage(sp, 0, 0)
                        return c
                    })()
                ),
                h('div', { class: 'chonk' }, CHONK_STAGES[s.stage])
            ),
            h(
                'div',
                { class: 'card-right' },
                h('h2', {}, hh.name.toUpperCase()),
                h('div', { class: 'role' }, hh.role, hh.pronouns ? ` · ${hh.pronouns}` : ''),
                badges,
                h(
                    'div',
                    { class: 'meters' },
                    h('div', { class: 'meter-row' }, h('b', {}, `LV ${s.level}`), bar((s.xp - levelXp) / (nextLevelXp - levelXp), '#2F80FA', `${s.xp} / ${nextLevelXp} XP`)),
                    h(
                        'div',
                        { class: 'meter-row' },
                        h('b', {}, 'BELLY'),
                        bar(fullness(s.lastFedAt, serverNow()), HUNGER_COLORS[s.hunger], `${HUNGER[s.hunger].label}${s.lastFedAt ? ` · fed ${timeAgo(s.lastFedAt, serverNow())}` : ' · never fed'}`)
                    )
                ),
                h(
                    'dl',
                    { class: 'facts' },
                    h('dt', {}, hh.teams.length > 1 ? 'TEAMS' : 'TEAM'),
                    h('dd', {}, hh.teams.join(', ')),
                    hh.location || hh.country ? [h('dt', {}, 'HABITAT'), h('dd', {}, `${flag(hh.country)} ${hh.location ?? hh.country}`)] : null,
                    h('dt', {}, 'JOINED'),
                    h('dd', {}, `${joined.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })} (${fmtNumber(daysAtPostHog)} days of service)`),
                    h('dt', {}, 'PINEAPPLE PIZZA'),
                    h('dd', {}, pineapple),
                    hh.heightCm ? [h('dt', {}, 'HUMAN FORM'), h('dd', {}, `${hh.heightCm}cm tall (hedgehog form: ${4 + s.stage * 2}cm)`)] : null,
                    h('dt', {}, 'SNACKS EATEN'),
                    h('dd', {}, String(s.feeds)),
                    h('dt', {}, 'FAVOURITE'),
                    h('dd', {}, favFood),
                    h('dt', {}, 'TOP FANS'),
                    h('dd', {}, fans)
                ),
                hh.bio ? h('p', { class: 'bio' }, h('b', {}, 'DEX ENTRY: '), hh.bio) : null,
                h(
                    'div',
                    { class: 'card-links' },
                    h('a', { href: `https://posthog.com/community/profiles/${hh.id}`, target: '_blank', rel: 'noopener' }, 'POSTHOG.COM PROFILE ↗'),
                    h('button', { class: 'btn small', onclick: () => findHog(hog) }, 'TRACK')
                ),
                h('details', { class: 'history' }, h('summary', {}, 'RECENT SNACKS'), recent)
            )
        ),
        feedPanel(hog)
    )
    openModal('hog', hh.shortName.toUpperCase(), body, { wide: true, accent: hh.color })
}

function feedPanel(hog: Hog): HTMLElement {
    const panel = h('div', { class: 'feed-panel' })
    const render = () => {
        const me = state.me
        const near = Math.hypot(hog.x - state.world.player.x, hog.y - state.world.player.y) < 60
        if (me?.fed) {
            const fedHog = ROSTER_BY_ID.get(me.fed.hedgehogId)
            const food = FOOD_BY_ID.get(me.fed.food)!
            const countdown = h('span', { class: 'countdown' }, fmtCountdown(me.nextResetAt - serverNow()))
            const tick = setInterval(() => {
                if (!countdown.isConnected) return clearInterval(tick)
                countdown.textContent = fmtCountdown(me.nextResetAt - serverNow())
            }, 1000)
            panel.replaceChildren(
                h(
                    'div',
                    { class: 'empty-bag' },
                    foodIcon(me.fed.food, 5),
                    h(
                        'div',
                        {},
                        h('h3', {}, 'SNACK BAG EMPTY'),
                        h(
                            'p',
                            {},
                            fedHog?.id === hog.h.id
                                ? `You already fed ${hog.h.shortName} ${article(food.name).toLowerCase()} ${food.name} today. They remember. They're grateful. Mostly.`
                                : `You fed ${fedHog?.shortName ?? 'a hedgehog'} today. The Hedgehog Nutrition Council allows one snack per farmer per day. No exceptions. Not even for ${hog.h.shortName}.`
                        ),
                        h('p', { class: 'next' }, 'NEXT SNACK IN ', countdown)
                    )
                )
            )
            return
        }
        if (!near) {
            panel.replaceChildren(
                h(
                    'div',
                    { class: 'far' },
                    h('p', {}, `${hog.h.shortName} is too far away to feed. Hedgehogs don't do delivery.`),
                    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => whistleHog(hog) }, '♪ WHISTLE THEM OVER'), h('button', { class: 'btn secondary', onclick: () => findHog(hog) }, 'WALK THERE'))
                )
            )
            return
        }
        let selected: FoodId = save.lastFood
        const desc = h('p', { class: 'food-desc' })
        const feedBtn = h('button', { class: 'btn big feed-btn' }, `FEED ${hog.h.shortName.toUpperCase()}!`)
        const items = FOODS.map((f, i) =>
            h(
                'button',
                {
                    class: 'food',
                    'data-food': f.id,
                    title: f.blurb,
                    onclick: () => select(f.id),
                    ondblclick: () => doFeed(),
                },
                h('span', { class: 'key' }, String(i + 1)),
                foodIcon(f.id, 4),
                h('span', { class: 'food-name' }, f.name),
                h('span', { class: 'food-xp' }, f.xp)
            )
        )
        const select = (id: FoodId) => {
            selected = id
            audio.play('blip')
            items.forEach((el) => el.classList.toggle('selected', el.dataset.food === id))
            const f = FOOD_BY_ID.get(id)!
            let hint = ''
            if (id === 'pizza' && hog.h.pineapple !== null) hint = hog.h.pineapple ? ` ${hog.h.shortName} LOVES pineapple on pizza.` : ` ⚠ ${hog.h.shortName} thinks pineapple on pizza is a crime.`
            desc.textContent = f.blurb + hint
        }
        const doFeed = async () => {
            if (feedBtn.disabled) return
            feedBtn.disabled = true
            feedBtn.textContent = 'FEEDING...'
            await feed(hog, selected)
            if (panel.isConnected) {
                feedBtn.disabled = false
                render()
            }
        }
        feedBtn.addEventListener('click', doFeed)
        const keyHandler = (e: KeyboardEvent) => {
            if (!panel.isConnected) return removeEventListener('keydown', keyHandler)
            const n = Number(e.key)
            if (n >= 1 && n <= FOODS.length) select(FOODS[n - 1].id)
            if (e.key === 'Enter') doFeed()
        }
        addEventListener('keydown', keyHandler)
        panel.replaceChildren(h('h3', {}, 'CHOOSE A SNACK ', h('small', {}, '(1 per day, choose wisely)')), h('div', { class: 'foods' }, items), h('div', { class: 'feed-row' }, desc, feedBtn))
        select(selected)
    }
    render()
    return panel
}

async function feed(hog: Hog, food: FoodId) {
    const hungerBefore = HUNGER[hungerLevel(hog.stats[2], serverNow())].label
    const res = await api.feed(hog.h.id, food)
    if (!res.ok) {
        track('hedgehog feed rejected', { ...hedgehogProperties(hog.h), food, error: res.error })
        audio.play('error')
        if (res.error === 'already_fed' && res.fed && state.me) {
            state.me = { ...state.me, fed: res.fed, nextResetAt: res.nextResetAt ?? state.me.nextResetAt }
            updateSnackChip()
        }
        toast(res.error === 'already_fed' ? 'SNACK BAG EMPTY' : 'NOPE', res.message, 'error')
        document.querySelector('.window')?.classList.add('shake')
        setTimeout(() => document.querySelector('.window')?.classList.remove('shake'), 400)
        return
    }
    const { event, stats, multipliers } = res
    const levelBefore = hog.level
    hog.setStats(stats)
    if (state.farm) {
        state.farm.stats[hog.h.id] = stats
        state.farm.recent.unshift(event)
        state.farm.feedsToday++
        state.farm.feedsAllTime++
    }
    seenEvents.add(eventKey(event))
    state.me = state.me ? { ...state.me, fed: { hedgehogId: hog.h.id, food, at: event.at } } : state.me
    recordFeed(hog.h.id, food)
    updateSnackChip()
    renderTicker()
    closeModal(true)
    state.world.celebrate(hog, food, event.outcome, event.xp, hog.level > levelBefore)
    setTimeout(() => {
        audio.play('coin')
        toast(OUTCOME_TITLES[event.outcome], `${hog.h.shortName} got +${event.xp} XP${multipliers.length ? ` (${multipliers.join(', ')})` : ''}. Come back tomorrow for another snack!`, 'win', 6000)
    }, 2300)

    track('hedgehog fed', {
        ...hedgehogProperties(hog.h),
        food,
        food_name: FOOD_BY_ID.get(food)!.name,
        outcome: event.outcome,
        xp: event.xp,
        multipliers,
        hunger_before: hungerBefore,
        level_before: levelBefore,
        level_after: hog.level,
        leveled_up: hog.level > levelBefore,
        hogiversary: multipliers.some((m) => m.startsWith('HOGIVERSARY')),
        streak: currentStreak(),
        // the farmer, as a person: how committed are they
        $set: { farm_snacks_served: save.fed.length, farm_streak: currentStreak() },
    })

    // trophies (shown after the celebration)
    trophyDelay = 3800
    award('first_snack')
    const streak = currentStreak()
    if (streak >= 3) award('streak_3')
    if (streak >= 7) award('streak_7')
    if (streak >= 30) award('streak_30')
    const byOutcome: Partial<Record<string, string>> = {
        pizza_love: 'pizza_love',
        pizza_hate: 'pizza_hate',
        zoomies: 'zoomies',
        flag_off: 'flag_off',
        flag_on: 'flag_on',
        mystery_sock: 'sock',
        mystery_gold: 'gold',
        water: 'water',
    }
    if (byOutcome[event.outcome]) award(byOutcome[event.outcome]!)
    if (multipliers.some((m) => m.startsWith('RESCUE'))) award('rescue')
    if (multipliers.some((m) => m.startsWith('HOGIVERSARY'))) award('hogiversary')
    if (/ceo|founder/i.test(hog.h.role)) award('founder')
    if (new Date().getHours() < 5) award('night_owl')
    trophyDelay = 400
}

// ---------------------------------------------------------------- remote events + ticker

const seenEvents = new Set<string>()
const eventKey = (e: FeedEvent) => `${e.hedgehogId}:${e.at}`

/** Called after every farm poll; animates feedings by other farmers */
export function ingestFarmEvents(first: boolean) {
    for (const e of state.farm?.recent ?? []) {
        const key = eventKey(e)
        if (seenEvents.has(key)) continue
        seenEvents.add(key)
        if (first) continue
        const hog = state.world.hogById.get(e.hedgehogId)
        if (hog) state.world.remoteFeed(hog)
    }
    renderTicker()
}

export function renderTicker() {
    const track = document.querySelector('#ticker .ticker-track')
    if (!track || !state.farm) return
    const items = state.farm.recent.slice(0, 15).map((e) => {
        const hog = ROSTER_BY_ID.get(e.hedgehogId)
        const food = FOOD_BY_ID.get(e.food)
        return h(
            'span',
            { class: 'tick' },
            `${flag(e.country)} `,
            h('b', {}, `${e.country ? `SOMEONE IN ${e.country}` : 'SOMEONE'}`),
            ' fed ',
            h('b', { style: { color: hog?.color } }, (hog?.shortName ?? '???').toUpperCase()),
            ` ${article(food?.name ?? 'A').toLowerCase()} ${food?.name ?? 'SNACK'} · +${e.xp} XP · ${timeAgo(e.at, serverNow())}`
        )
    })
    if (!items.length) items.push(h('span', { class: 'tick' }, 'No snacks served yet today. The hedgehogs are... waiting. Staring. Be the first!'))
    // one copy only: the track starts off-screen right (padding-left: 100%) and scrolls through once per loop
    track.replaceChildren(...items)
    ;(track as HTMLElement).style.animationDuration = `${Math.max(20, items.length * 7)}s`
}

// ---------------------------------------------------------------- HUD

export function updateSnackChip() {
    const chip = document.getElementById('snack')!
    const me = state.me
    // while the snack is ready, the compass nudges you towards today's party hogs
    state.world.partyCompass = !!me && !me.fed
    if (!me) {
        chip.textContent = 'CHECKING SNACK BAG...'
        return
    }
    if (me.fed) {
        chip.className = 'chip snack empty'
        chip.replaceChildren(h('span', { class: 'label' }, 'NEXT SNACK '), h('span', { class: 'countdown' }, fmtCountdown(me.nextResetAt - serverNow())))
    } else {
        chip.className = 'chip snack ready'
        chip.replaceChildren(foodIcon(save.lastFood, 2), h('span', {}, ' SNACK READY! 1/1'))
    }
}

export function updatePartyChip() {
    const chip = document.getElementById('party')!
    const day = state.farm?.day
    if (!day) return chip.replaceChildren()
    const party = hogiversariesOn(day)
    if (party.length) {
        chip.className = 'chip party'
        chip.replaceChildren(
            h('div', { class: 'party-title' }, `🎉 HOGIVERSAR${party.length > 1 ? 'IES' : 'Y'} TODAY · 1.5X XP`),
            h(
                'div',
                { class: 'party-list' },
                ...party.map((p) =>
                    h(
                        'button',
                        { class: 'party-hog', title: `Find ${p.name}`, onclick: () => findHog(state.world.hogById.get(p.id)!) },
                        portrait(p, 16, 'portrait tiny'),
                        h('span', {}, p.name.toUpperCase()),
                        h('small', {}, `${yearsAtPostHog(p, day)}Y`)
                    )
                )
            )
        )
        return
    }
    const next = nextHogiversary(day)
    chip.className = 'chip party none'
    const names = next?.hedgehogs.map((n) => n.shortName.toUpperCase()) ?? []
    chip.replaceChildren(
        h('div', { class: 'party-title' }, 'NO HOGIVERSARIES TODAY'),
        ...(next
            ? [h(
                  'small',
                  {},
                  `NEXT PARTY: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''} ON ${new Date(`${next.day}T00:00:00Z`)
                      .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
                      .toUpperCase()}`
              )]
            : [])
    )
}

// ---------------------------------------------------------------- dex

export function openDex() {
    track('panel opened', { panel: 'dex' })
    const teams = [...new Set(ROSTER.flatMap((r) => r.teams))].sort()
    const search = h('input', { type: 'search', placeholder: 'SEARCH HEDGEHOGS...', autocomplete: 'off', spellcheck: false })
    const teamSel = h('select', {}, h('option', { value: '' }, 'ALL TEAMS'), ...teams.map((t) => h('option', { value: t }, t.toUpperCase())))
    const sortSel = h(
        'select',
        {},
        h('option', { value: 'name' }, 'A → Z'),
        h('option', { value: 'level' }, 'CHONKIEST'),
        h('option', { value: 'hungry' }, 'HUNGRIEST'),
        h('option', { value: 'new' }, 'NEWEST'),
        h('option', { value: 'old' }, 'OG HOGS')
    )
    const grid = h('div', { class: 'dex-grid' })
    const count = h('span', { class: 'dex-count' })
    const render = () => {
        const q = search.value.trim().toLowerCase()
        let list = ROSTER.filter(
            (r) =>
                (!teamSel.value || r.teams.includes(teamSel.value)) &&
                (!q || `${r.name} ${r.role} ${r.teams.join(' ')} ${r.location ?? ''}`.toLowerCase().includes(q))
        )
        const st = (id: number) => statsOf(id)
        list = [...list].sort((a, b) => {
            switch (sortSel.value) {
                case 'level':
                    return st(b.id).xp - st(a.id).xp
                case 'hungry':
                    return (st(a.id).lastFedAt ?? 0) - (st(b.id).lastFedAt ?? 0)
                case 'new':
                    return b.startDate.localeCompare(a.startDate)
                case 'old':
                    return a.startDate.localeCompare(b.startDate)
                default:
                    return a.name.localeCompare(b.name)
            }
        })
        count.textContent = `${list.length} SHOWN · MET ${seenCount()}/${ROSTER.length}`
        grid.replaceChildren(
            ...list.map((r) => {
                const s = st(r.id)
                const met = hasSeen(r.id)
                const party = state.world.partyIds.has(r.id)
                return h(
                    'button',
                    {
                        class: `dex-entry ${met ? '' : 'unmet'} ${party ? 'party' : ''}`,
                        style: { '--c': r.color },
                        onclick: () => openHedgehog(state.world.hogById.get(r.id)!, 'dex'),
                    },
                    portrait(r, 16, 'portrait small'),
                    h('span', { class: 'dex-name' }, party ? '🎉 ' : '', r.name),
                    h('span', { class: 'dex-meta' }, `LV${s.level} · `, h('span', { style: { color: HUNGER_COLORS[s.hunger] } }, HUNGER[s.hunger].label)),
                    h('span', { class: 'dex-team' }, r.teams[0])
                )
            })
        )
    }
    let debounce = 0
    search.addEventListener('input', () => {
        clearTimeout(debounce)
        debounce = window.setTimeout(render, 120)
    })
    teamSel.addEventListener('change', render)
    sortSel.addEventListener('change', render)
    render()
    openModal('dex', 'HEDGEDEX', h('div', { class: 'dex' }, h('div', { class: 'dex-controls' }, search, teamSel, sortSel), count, grid), { wide: true })
    setTimeout(() => search.focus(), 50)
}

// ---------------------------------------------------------------- ranks

export function openRanks(tab: 'chonk' | 'hungry' | 'teams' | 'log' = 'chonk') {
    track('panel opened', { panel: 'ranks' })
    const tabs = h('div', { class: 'tabs' })
    const content = h('div', { class: 'ranks' })
    const row = (rank: number, r: Hedgehog, right: (Node | string)[]) =>
        h(
            'button',
            { class: 'rank-row', onclick: () => openHedgehog(state.world.hogById.get(r.id)!, 'ranks') },
            h('span', { class: `rank r${rank}` }, rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : `#${rank}`),
            portrait(r, 16, 'portrait tiny'),
            h('span', { class: 'rank-name' }, r.name, h('small', {}, r.teams[0])),
            h('span', { class: 'rank-right' }, ...right)
        )
    const show = (t: typeof tab) => {
        audio.play('blip')
        tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t))
        if (t === 'chonk') {
            const list = [...ROSTER].sort((a, b) => statsOf(b.id).xp - statsOf(a.id).xp).slice(0, 30)
            content.replaceChildren(
                h('p', { class: 'hint' }, 'The roundest hedgehogs on the farm. Peak performance.'),
                ...list.map((r, i) => {
                    const s = statsOf(r.id)
                    return row(i + 1, r, [h('b', {}, `LV${s.level}`), ` ${s.xp} XP · ${CHONK_STAGES[s.stage]}`])
                })
            )
        } else if (t === 'hungry') {
            const list = [...ROSTER].sort((a, b) => (statsOf(a.id).lastFedAt ?? 0) - (statsOf(b.id).lastFedAt ?? 0)).slice(0, 30)
            content.replaceChildren(
                h('p', { class: 'hint' }, 'These hedgehogs need you. Starving hedgehogs give 1.5x XP.'),
                ...list.map((r, i) => {
                    const s = statsOf(r.id)
                    return row(i + 1, r, [
                        h('b', { style: { color: HUNGER_COLORS[s.hunger] } }, HUNGER[s.hunger].label),
                        ` · ${s.lastFedAt ? `fed ${timeAgo(s.lastFedAt, serverNow())}` : 'never fed 😢'}`,
                    ])
                })
            )
        } else if (t === 'teams') {
            const teams = new Map<string, { xp: number; feeds: number; members: number }>()
            for (const r of ROSTER) {
                const s = statsOf(r.id)
                for (const team of r.teams) {
                    const tt = teams.get(team) ?? { xp: 0, feeds: 0, members: 0 }
                    tt.xp += s.xp
                    tt.feeds += s.feeds
                    tt.members++
                    teams.set(team, tt)
                }
            }
            const list = [...teams.entries()].sort((a, b) => b[1].xp / b[1].members - a[1].xp / a[1].members)
            content.replaceChildren(
                h('p', { class: 'hint' }, 'Average XP per hedgehog. Small teams, big bellies.'),
                ...list.map(([team, tt], i) =>
                    h(
                        'div',
                        { class: 'rank-row static' },
                        h('span', { class: 'rank' }, i < 3 ? ['🥇', '🥈', '🥉'][i] : `#${i + 1}`),
                        h('span', { class: 'rank-name' }, team.toUpperCase(), h('small', {}, `${tt.members} hedgehogs`)),
                        h('span', { class: 'rank-right' }, h('b', {}, `${Math.round(tt.xp / tt.members)} XP/hog`), ` · ${tt.feeds} snacks`)
                    )
                )
            )
        } else {
            const recent = state.farm?.recent ?? []
            content.replaceChildren(
                h('p', { class: 'hint' }, `${fmtNumber(state.farm?.feedsToday ?? 0)} snacks served today · ${fmtNumber(state.farm?.feedsAllTime ?? 0)} all time`),
                ...(recent.length
                    ? recent.map((e) => {
                          const r = ROSTER_BY_ID.get(e.hedgehogId)
                          if (!r) return h('span')
                          return h(
                              'button',
                              { class: 'rank-row', onclick: () => openHedgehog(state.world.hogById.get(r.id)!, 'ranks') },
                              h('span', { class: 'rank' }, flag(e.country)),
                              foodIcon(e.food, 3),
                              h('span', { class: 'rank-name' }, r.name, h('small', {}, `${FOOD_BY_ID.get(e.food)!.name} · ${OUTCOME_TITLES[e.outcome]}`)),
                              h('span', { class: 'rank-right' }, h('b', {}, `+${e.xp} XP`), ` · ${timeAgo(e.at, serverNow())}`)
                          )
                      })
                    : [h('p', {}, 'Nothing yet. Suspiciously quiet.')])
            )
        }
    }
    const labels = { chonk: 'CHONKIEST', hungry: 'HUNGRIEST', teams: 'TEAMS', log: 'SNACK LOG' } as const
    for (const [k, label] of Object.entries(labels)) tabs.append(h('button', { 'data-tab': k, onclick: () => show(k as typeof tab) }, label))
    openModal('ranks', 'NOTICEBOARD', h('div', {}, tabs, content), { wide: true })
    show(tab)
}

// ---------------------------------------------------------------- farmer

export function openFarmer() {
    track('panel opened', { panel: 'farmer' })
    const streak = currentStreak()
    const me = state.me
    const fedToday = me?.fed ? ROSTER_BY_ID.get(me.fed.hedgehogId) : null
    const unlocked = new Set(save.trophies)
    const body = h(
        'div',
        { class: 'farmer' },
        h(
            'div',
            { class: 'farmer-stats' },
            (() => {
                const sp = S.farmerSprite('down', 0)
                const c = h('canvas', { width: sp.width, height: sp.height, style: { width: `${sp.width * 6}px`, height: `${sp.height * 6}px` } })
                c.getContext('2d')!.drawImage(sp, 0, 0)
                return c
            })(),
            h(
                'dl',
                { class: 'facts' },
                h('dt', {}, 'STREAK'),
                h('dd', {}, `${streak} day${streak === 1 ? '' : 's'} ${streak >= 3 ? '🔥' : ''}`),
                h('dt', {}, 'SNACKS SERVED'),
                h('dd', {}, String(save.fed.length)),
                h('dt', {}, 'HEDGEHOGS MET'),
                h('dd', {}, `${seenCount()} / ${ROSTER.length}`),
                h('dt', {}, 'TODAY'),
                h('dd', {}, fedToday ? `Fed ${fedToday.name} ${article(FOOD_BY_ID.get(me!.fed!.food)!.name).toLowerCase()} ${FOOD_BY_ID.get(me!.fed!.food)!.name}` : 'Snack bag is full. Go feed someone!'),
                h('dt', {}, 'TROPHIES'),
                h('dd', {}, `${unlocked.size} / ${TROPHIES.length}`),
                h('dt', {}, 'DAYS TO FEED EVERYONE'),
                h('dd', {}, `${Math.max(0, ROSTER.length - new Set(save.fed.map((f) => f.hedgehogId)).size)} (at least you're committed)`)
            )
        ),
        h('h3', {}, 'TROPHY CABINET'),
        h(
            'div',
            { class: 'trophies' },
            ...TROPHIES.map((t) =>
                h(
                    'div',
                    { class: `trophy ${unlocked.has(t.id) ? 'got' : ''}` },
                    h('span', { class: 'cup' }, unlocked.has(t.id) ? '🏆' : '🔒'),
                    h('b', {}, unlocked.has(t.id) ? t.name : '???'),
                    h('small', {}, unlocked.has(t.id) ? t.desc : t.desc.replace(/[A-Za-z]/g, (c, i) => (i % 3 ? '·' : c)))
                )
            )
        ),
        h('p', { class: 'hint' }, 'Progress is saved in this browser. Snack limits are enforced by the barn (the server), so no cheating, farmer.')
    )
    openModal('farmer', 'FARMER STATS', body, { wide: true })
}

// ---------------------------------------------------------------- help

export function openHelp() {
    track('panel opened', { panel: 'help' })
    const body = h(
        'div',
        { class: 'help' },
        h('h3', {}, 'WELCOME TO POSTHOG FARM'),
        h('p', {}, `${ROSTER.length} hedgehogs live here. Each one is a real PostHog team member. They are all hungry. You have exactly ONE snack per day.`),
        h('h3', {}, 'HOW TO PLAY'),
        h(
            'ul',
            {},
            h('li', {}, 'Walk up to a hedgehog and say hi. Pick a snack. Feed them. They get XP and get chonkier.'),
            h('li', {}, 'One snack per farmer per day (per IP, resets at 00:00 UTC). The barn keeps a ledger. The barn never forgets.'),
            h('li', {}, 'Hedgehogs on their PostHog anniversary (their HOGIVERSARY) wear a party hat and get 1.5x XP. The banner in the bottom-left shows who is celebrating.'),
            h('li', {}, 'STARVING hedgehogs (not fed for 4+ days) give 1.5x XP. Be a hero.'),
            h('li', {}, 'Pineapple pizza is +25 XP for believers and +2 for haters. Read the room.'),
            h('li', {}, 'Hedgehogs are nocturnal: more of them nap during the day, and they get zippier at night.')
        ),
        h('h3', {}, 'CONTROLS'),
        h(
            'div',
            { class: 'controls' },
            ...[
                ['WASD / ARROWS', 'walk (hold SHIFT to run)'],
                ['CLICK / TAP', 'walk somewhere or to a hedgehog'],
                ['E / SPACE', 'say hi / interact'],
                ['1-8, ENTER', 'pick a snack, feed'],
                ['Q', 'Hedgedex'],
                ['R', 'rankings'],
                ['F', 'farmer stats + trophies'],
                ['G', 'find a hogiversary hedgehog'],
                ['N', 'show all names'],
                ['M', 'music on/off'],
                ['+ / - / SCROLL / PINCH', 'zoom (0 resets)'],
                ['ESC', 'close windows'],
            ].map(([k, v]) => h('div', {}, h('kbd', {}, k), h('span', {}, v)))
        ),
        h('h3', {}, 'FAQ'),
        h(
            'dl',
            { class: 'faq' },
            h('dt', {}, 'Why only one snack a day?'),
            h('dd', {}, "Hedgehog obesity is a real problem. Also, it makes your choice matter. Also, a Durable Object said so."),
            h('dt', {}, 'Where did my favourite hedgehog go?'),
            h('dd', {}, 'The farm is rebuilt every day from the PostHog team page. New hedgehogs move in, departing ones retire to a nicer farm.'),
            h('dt', {}, 'Is that really what they look like?'),
            h('dd', {}, 'In hedgehog form, yes. Their human form is on posthog.com/people.'),
            h('dt', {}, 'Can I feed the farmer?'),
            h('dd', {}, 'No.')
        )
    )
    openModal('help', 'HOW TO PLAY', body, { wide: true })
}

// ---------------------------------------------------------------- props

const POND_LINES = [
    'You stare into the pond. A handsome farmer stares back.',
    'The pond reflects on its life choices. So do you.',
    'A frog judges you silently.',
    'You see your reflection. Looking good, farmer.',
    'There is a mealworm at the bottom. It is out of reach. Like most dreams.',
    'The pond says: "have you tried session replay?"',
]

export function onPropAction(action: PropAction) {
    if (action === 'ranks') openRanks()
    else if (action === 'farmer') openFarmer()
    else if (action === 'help') openHelp()
    else if (action === 'pond') {
        audio.play('blip')
        toast('THE POND', pick(POND_LINES), 'info', 3500)
        award('pond')
    }
}

export function checkMeetTrophies() {
    const n = seenCount()
    if (n >= 25) award('meet_25')
    if (n >= 100) award('meet_100')
    if (n >= ROSTER.length) award('meet_all')
}

export function toggleSetting(key: 'music' | 'sfx' | 'names') {
    save[key] = !save[key]
    track('setting toggled', { setting: key, enabled: save[key] })
    persist()
    if (key === 'music') audio.setMusic(save.music)
    if (key === 'sfx') audio.setSfx(save.sfx)
    if (key === 'names') state.world.showNames = save.names
    document.querySelector(`[data-action="${key}"]`)?.classList.toggle('off', !save[key])
    toast(`${key.toUpperCase()} ${save[key] ? 'ON' : 'OFF'}`, '', 'info', 1200)
}
