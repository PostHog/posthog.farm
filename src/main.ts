import '@fontsource/press-start-2p'
import '@fontsource/vt323'
import './style.css'

import { ROSTER, ROSTER_GENERATED_AT } from '../shared/game'
import { initAnalytics, track } from './analytics'
import { api } from './api'
import { audio } from './audio'
import { fmtNumber, h } from './dom'
import { pick } from './lines'
import { markSeen, persist, save, seenCount } from './save'
import * as S from './sprites'
import { serverNow, state } from './state'
import {
    checkMeetTrophies,
    closeModal,
    findHog,
    ingestFarmEvents,
    isModalOpen,
    isTyping,
    onPropAction,
    openDex,
    openFarmer,
    openHedgehog,
    openHelp,
    openRanks,
    toast,
    toggleSetting,
    updatePartyChip,
    updateSnackChip,
} from './ui'
import { World } from './world'

initAnalytics()

const canvas = document.getElementById('world') as HTMLCanvasElement
const world = new World(canvas)
state.world = world
world.showNames = save.names
audio.sfxOn = save.sfx
audio.musicOn = save.music
for (const key of ['music', 'sfx', 'names'] as const) document.querySelector(`[data-action="${key}"]`)?.classList.toggle('off', !save[key])

let introOpen = false

world.onHog = (hog) => {
    if (isModalOpen() || introOpen) return
    // we found someone: stop tracking/whistling for anyone else
    world.stopTracking()
    // Hold still while we chat
    hog.state = 'idle'
    hog.timer = 15
    hog.facing = world.player.x < hog.x ? -1 : 1
    openHedgehog(hog)
}
world.onProp = (action) => {
    if (isModalOpen() || introOpen) return
    onPropAction(action)
}
world.onMeet = (hog) => {
    if (markSeen(hog.h.id)) {
        world.emote(hog)
        checkMeetTrophies()
    }
}
requestAnimationFrame(world.frame)

// ---------------------------------------------------------------- server sync

async function refreshFarm(first = false) {
    try {
        const farm = await api.farm()
        state.clockSkew = farm.now - Date.now()
        const dayChanged = state.farm && farm.day !== state.farm.day
        state.farm = farm
        world.applyStats(farm.stats, farm.day)
        updatePartyChip()
        ingestFarmEvents(first)
        updateTitleStats()
        if (dayChanged) refreshMe()
    } catch (e) {
        console.warn('Could not reach the barn', e)
    }
}

async function refreshMe() {
    try {
        const hadFed = !!state.me?.fed
        state.me = await api.me()
        updateSnackChip()
        if (hadFed && !state.me.fed) {
            audio.play('levelup')
            toast('☀ A NEW DAY DAWNS', 'Your snack bag has been refilled. The hedgehogs have noticed.', 'win', 6000)
        }
    } catch (e) {
        console.warn('Could not check the snack bag', e)
    }
}

refreshFarm(true)
refreshMe()
setInterval(refreshFarm, 15_000)
setInterval(() => {
    updateSnackChip()
    if (state.me?.fed && serverNow() >= state.me.nextResetAt + 1000) {
        state.me = { ...state.me, fed: null, nextResetAt: state.me.nextResetAt + 86_400_000 }
        refreshMe()
        refreshFarm()
    }
}, 1000)
addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        refreshFarm()
        refreshMe()
    }
})

const minimap = document.getElementById('minimap') as HTMLCanvasElement
setInterval(() => world.mode === 'play' && world.drawMinimap(minimap, performance.now()), 200)

// ---------------------------------------------------------------- title screen

const title = document.getElementById('title')!
const hud = document.getElementById('hud')!

function updateTitleStats() {
    const el = document.getElementById('title-stats')
    if (!el || !state.farm) return
    el.textContent = `${ROSTER.length} HEDGEHOGS · ${fmtNumber(state.farm.feedsAllTime)} SNACKS SERVED · ${fmtNumber(state.farm.feedsToday)} TODAY`
}

function buildParade() {
    const parade = document.getElementById('parade')!
    const picks = Array.from({ length: 7 }, () => pick(ROSTER))
    picks.forEach((r, i) => {
        const frames = [S.hedgehogSprite(r.color, i % 5, 'walk0'), S.hedgehogSprite(r.color, i % 5, 'walk1')]
        const c = h('canvas', { width: frames[0].width, height: frames[0].height, class: 'parade-hog', title: r.name })
        c.style.width = `${frames[0].width * 4}px`
        c.style.height = `${frames[0].height * 4}px`
        c.style.animationDelay = `${-i * 2.2}s`
        const ctx = c.getContext('2d')!
        let f = 0
        setInterval(() => {
            ctx.clearRect(0, 0, c.width, c.height)
            ctx.drawImage(frames[(f = 1 - f)], 0, 0)
        }, 180 + i * 7)
        parade.append(c)
    })
    document.getElementById('roster-date')!.textContent = `ROSTER UPDATED ${new Date(ROSTER_GENERATED_AT).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase()}`
}
buildParade()

function start() {
    if (world.mode === 'play') return
    track('game started', { returning: save.introSeen, hedgehogs_met: seenCount(), trophies_unlocked: save.trophies.length })
    audio.unlock()
    audio.play('start')
    title.classList.add('leaving')
    setTimeout(() => title.remove(), 500)
    hud.hidden = false
    world.startPlaying()
    if (!save.introSeen) setTimeout(runIntro, 600)
    // warm up the tiny pixel portraits so they pop up instantly when you meet someone
    setTimeout(() => ROSTER.forEach((r) => S.pixelPortrait(r.avatar, 16)), 1500)
}
document.getElementById('start')!.addEventListener('click', start)

// ---------------------------------------------------------------- intro dialog

function runIntro() {
    const lines = [
        'Howdy, farmer! Welcome to POSTHOG FARM. I\'m Max, the farm manager.',
        `${ROSTER.length} hedgehogs live here. Every single one is a real PostHog team member, in their true form.`,
        'They are hungry. Always. But the Hedgehog Nutrition Council only allows ONE snack per farmer per day.',
        'So choose wisely! Walk up to a hedgehog (WASD, arrows or tap), say hi, and pick a snack. Fed hedgehogs level up and get CHONKY.',
        'Psst... hedgehogs wearing a party hat are celebrating their PostHog anniversary today. Their snacks are worth 1.5x. Off you go!',
    ]
    introOpen = true
    world.paused = true
    const text = h('p', { class: 'dialog-text' })
    const more = h('span', { class: 'dialog-more' }, '▼')
    const sp = S.hedgehogSprite('#F7A501', 2, 'walk0')
    const face = h('canvas', { width: sp.width, height: sp.height, style: { width: `${sp.width * 4}px`, height: `${sp.height * 4}px` } })
    face.getContext('2d')!.drawImage(sp, 0, 0)
    const box = h('div', { class: 'dialog' }, h('div', { class: 'dialog-face' }, face, h('b', {}, 'MAX')), text, more)
    document.body.append(box)
    let i = 0
    let typing = 0
    let full = ''
    const show = () => {
        full = lines[i]
        let n = 0
        clearInterval(typing)
        text.textContent = ''
        typing = window.setInterval(() => {
            n++
            text.textContent = full.slice(0, n)
            if (n % 2 === 0) audio.play('blip')
            if (n >= full.length) clearInterval(typing)
        }, 22)
    }
    const advance = () => {
        if (text.textContent!.length < full.length) {
            clearInterval(typing)
            text.textContent = full
            return
        }
        i++
        if (i >= lines.length) {
            box.remove()
            removeEventListener('keydown', onKey, true)
            introOpen = false
            world.paused = false
            save.introSeen = true
            persist()
            return
        }
        audio.play('select')
        show()
    }
    const onKey = (e: KeyboardEvent) => {
        if (['Enter', ' ', 'e', 'E', 'Escape'].includes(e.key)) {
            e.preventDefault()
            e.stopImmediatePropagation()
            advance()
        }
    }
    box.addEventListener('click', advance)
    addEventListener('keydown', onKey, true)
    show()
}

// ---------------------------------------------------------------- HUD + keys

hud.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action
    if (!action || introOpen) return
    if (action === 'dex') openDex()
    if (action === 'ranks') openRanks()
    if (action === 'farmer') openFarmer()
    if (action === 'help') openHelp()
    if (action === 'music' || action === 'sfx' || action === 'names') toggleSetting(action)
    if (action === 'zoom-in') world.zoomBy(1)
    if (action === 'zoom-out') world.zoomBy(-1)
})

addEventListener('keydown', (e) => {
    if (world.mode === 'title') {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            start()
        }
        return
    }
    if (introOpen) return
    if (e.key === 'Escape') return closeModal()
    if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key.toLowerCase()
    if (isModalOpen()) {
        // let shortcut keys switch between windows
        if (!['q', 'r', 'f', 'h', '?'].includes(k)) return
    }
    if (k === 'q') openDex()
    else if (k === 'r') openRanks()
    else if (k === 'f') openFarmer()
    else if (k === 'h' || k === '?') openHelp()
    else if (k === 'm') toggleSetting('music')
    else if (k === 'n') toggleSetting('names')
    else if (k === 'g') {
        const party = world.nearestPartyHog()
        if (party) findHog(party)
        else toast('NO HOGIVERSARIES TODAY', 'Nobody is wearing a party hat today. Check the banner for the next party.')
    }
})

// Hedgehogs are a serious business
console.log(
    '%c🦔 POSTHOG FARM %c\nOne snack per IP per day, enforced by a Durable Object. Nice try though.',
    'font: bold 20px monospace; color: #F54E00',
    'font: 12px monospace'
)
