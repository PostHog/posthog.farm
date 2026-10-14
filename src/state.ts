import type { FarmState, MeState } from '../shared/game'
import type { World } from './world'

/** Client-side game state, shared between the HUD and the modals */
export const state = {
    world: null as unknown as World,
    farm: null as FarmState | null,
    me: null as MeState | null,
    /** server clock minus local clock, so countdowns don't depend on a wrong local clock */
    clockSkew: 0,
}

export const serverNow = () => Date.now() + state.clockSkew
