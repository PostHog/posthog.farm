import { type Hedgehog, type Outcome, hungerLevel, isHogiversary, isNewbie, yearsAtPostHog } from '../shared/game'

export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]

const GENERIC = [
    '*snuffle snuffle*',
    'I\'d ship that.',
    'Is it standup already?',
    'Hog life.',
    'Did someone say mealworms?',
    "I'm not round, I'm feature-rich.",
    '*rolls into a ball*',
    'I am 80% spikes, 20% vibes.',
    'My KPI is Keep Providing Insects.',
    'This could have been an async message.',
    'Who moved my mealworm?',
    'Ship it.',
    'I just closed 47 tabs.',
    'brb, hibernating',
    'Have you checked the session replay?',
    'Is this a feature or a bug? Yes.',
    "I don't do meetings. I do snacks.",
    'Write it down in the handbook.',
    'Any insects? Asking for a friend.',
    '*aggressive sniffing*',
    'Hog of the people.',
    "We're default alive. Are you?",
    'Somebody fed me an RFC once.',
    'I identify as a feature flag.',
    'One snack a day keeps the farmer away.',
    'Funnel analysis: mouth → belly.',
    'That pond has great reflections. Very insightful.',
    'Who let the farmer in?',
]

export function chatterFor(h: Hedgehog, opts: { lastFedAt: number | null; day: string; sleeping: boolean }): string {
    if (opts.sleeping) return pick(['zzz...', '*snore*', 'five more minutes...', 'zzz... mealworms... zzz'])
    const lines = [...GENERIC]
    const team = pick(h.teams)
    lines.push(`Team ${team} represent!`, `Ask me about ${team}.`)
    if (h.location) lines.push(`Greetings from ${h.location}!`, `${h.location} misses me.`)
    if (h.pineapple === true) lines.push('Pineapple on pizza is objectively correct.', 'I have a tropical secret.')
    if (h.pineapple === false) lines.push('Pineapple on pizza is a war crime.', 'If you bring pineapple pizza, I bite.')
    if (h.leadTeams.length) lines.push(`I lead ${h.leadTeams[0]}. Mostly by vibes.`)
    if (/ceo|founder/i.test(h.role)) lines.push('Have you tried shipping faster?', 'I have opinions about this barn.')
    if (isNewbie(h)) lines.push("I'm new here! Where's the snack drawer?", 'Onboarding is going great. What is a hog?')
    const hunger = hungerLevel(opts.lastFedAt)
    if (hunger >= 4) lines.push('...so hungry...', 'Feed me, farmer. I am begging.', 'My belly is making async noises.')
    if (hunger === 0) lines.push("I couldn't possibly eat another... ok maybe one.", '*food coma*')
    if (isHogiversary(h, opts.day)) {
        const years = yearsAtPostHog(h, opts.day)
        // on their big day, they talk about little else
        return pick([
            `It's my ${years}-year hogiversary!`,
            'Party hog! Party hog!',
            'Do you like my hat?',
            `${years} year${years === 1 ? '' : 's'} at PostHog. Cake please.`,
            'Birthday snacks are worth 1.5x. Just saying.',
        ])
    }
    return pick(lines)
}

export function greetingFor(h: Hedgehog): string {
    return pick([`Hi, I'm ${h.shortName}!`, `Oh hey, farmer! I'm ${h.shortName}.`, `${h.shortName}. Pleased to meet you.`, `*sniff* ...you smell like snacks.`])
}

export const OUTCOME_LINES: Record<Outcome, string[]> = {
    nom: ['*happy crunching*', 'Nom nom nom!', 'Delicious. 10/10.', 'Chef\'s kiss.', 'This is the best day of my life.'],
    pizza_love: ['A FARMER OF CULTURE!', 'Pineapple! On pizza! Finally, justice.', 'You get me. You really get me.'],
    pizza_hate: ["...I'll eat it. But I'm telling HR.", '*visible disgust* thanks I guess', 'This is a diplomatic incident.'],
    pizza_meh: ['I have no strong opinions. Nom.', 'Pizza is pizza.'],
    zoomies: ['I CAN SEE SOUNDS', 'SHIP SHIP SHIP SHIP', 'ZOOM ZOOM ZOOM', 'WHO WANTS TO REFACTOR'],
    flag_on: ['Flag evaluated to TRUE! Jackpot!', "I'm in the test group!"],
    flag_off: ['Flag evaluated to false. Nothing happened.', "I'm in the control group :(", '...was that it?'],
    water: ["It's... crunchy water?", 'Thanks. I hate it.', 'Hydrated. Not happy.'],
    mystery_gold: ['A GOLDEN MEALWORM!!!', 'LEGENDARY DROP!'],
    mystery_sock: ["It's a sock. Why is it a sock.", '...a used sock. Cool. Cool cool cool.'],
    mystery_snack: ['Ooh, mystery crumbs!', 'Tastes like the offsite.', 'Is this... a muffin?'],
}

export const OUTCOME_TITLES: Record<Outcome, string> = {
    nom: 'NOM NOM NOM',
    pizza_love: 'A PERSON OF CULTURE',
    pizza_hate: 'DIPLOMATIC INCIDENT',
    pizza_meh: 'PIZZA IS PIZZA',
    zoomies: 'ZOOMIES UNLOCKED',
    flag_on: 'FLAG: TRUE',
    flag_off: 'FLAG: FALSE',
    water: 'HYDRATED, NOT HAPPY',
    mystery_gold: 'LEGENDARY DROP!',
    mystery_sock: 'IT WAS A SOCK',
    mystery_snack: 'MYSTERY CRUMBS',
}
