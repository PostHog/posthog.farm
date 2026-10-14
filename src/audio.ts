// Tiny chiptune engine: square/triangle oscillators and a noise hi-hat. No audio files.

type Sfx = 'select' | 'open' | 'close' | 'nom' | 'levelup' | 'error' | 'whistle' | 'coin' | 'trophy' | 'start' | 'blip'

let ctx: AudioContext | null = null
let master: GainNode
let sfxGain: GainNode
let musicGain: GainNode
let noiseBuffer: AudioBuffer

export const audio = {
    sfxOn: true,
    musicOn: true,

    unlock() {
        if (ctx) return void ctx.resume()
        ctx = new AudioContext()
        master = ctx.createGain()
        master.gain.value = 0.5
        master.connect(ctx.destination)
        sfxGain = ctx.createGain()
        sfxGain.gain.value = this.sfxOn ? 1 : 0
        sfxGain.connect(master)
        musicGain = ctx.createGain()
        musicGain.gain.value = this.musicOn ? 0.35 : 0
        musicGain.connect(master)
        noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate)
        const d = noiseBuffer.getChannelData(0)
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
        startMusic()
    },

    setSfx(on: boolean) {
        this.sfxOn = on
        if (ctx) sfxGain.gain.value = on ? 1 : 0
    },

    setMusic(on: boolean) {
        this.musicOn = on
        if (ctx) musicGain.gain.setTargetAtTime(on ? 0.35 : 0, ctx.currentTime, 0.1)
    },

    play(name: Sfx) {
        if (!ctx || !this.sfxOn) return
        const t = ctx.currentTime
        switch (name) {
            case 'blip':
                tone(sfxGain, 880, t, 0.04, 'square', 0.08)
                break
            case 'select':
                tone(sfxGain, 660, t, 0.05, 'square', 0.12)
                tone(sfxGain, 990, t + 0.05, 0.06, 'square', 0.12)
                break
            case 'open':
                ;[523, 659, 784].forEach((f, i) => tone(sfxGain, f, t + i * 0.05, 0.07, 'square', 0.12))
                break
            case 'close':
                ;[784, 523].forEach((f, i) => tone(sfxGain, f, t + i * 0.05, 0.07, 'square', 0.1))
                break
            case 'nom':
                for (let i = 0; i < 4; i++) {
                    tone(sfxGain, 180 + Math.random() * 60, t + i * 0.13, 0.06, 'square', 0.18, 90)
                    noise(sfxGain, t + i * 0.13 + 0.02, 0.05, 0.08)
                }
                break
            case 'levelup':
                ;[523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(sfxGain, f, t + i * 0.08, 0.1, 'square', 0.14))
                break
            case 'error':
                tone(sfxGain, 150, t, 0.12, 'square', 0.18)
                tone(sfxGain, 110, t + 0.13, 0.2, 'square', 0.18)
                break
            case 'whistle':
                tone(sfxGain, 1400, t, 0.18, 'sine', 0.2, 2200)
                tone(sfxGain, 1500, t + 0.22, 0.25, 'sine', 0.2, 2600)
                break
            case 'coin':
                tone(sfxGain, 988, t, 0.06, 'square', 0.14)
                tone(sfxGain, 1319, t + 0.06, 0.25, 'square', 0.14)
                break
            case 'trophy':
                ;[659, 784, 988, 1319].forEach((f, i) => tone(sfxGain, f, t + i * 0.1, 0.14, 'triangle', 0.25))
                ;[659, 784, 988, 1319].forEach((f, i) => tone(sfxGain, f * 2, t + i * 0.1, 0.1, 'square', 0.05))
                break
            case 'start':
                ;[392, 523, 659, 784, 1047].forEach((f, i) => tone(sfxGain, f, t + i * 0.07, 0.12, 'square', 0.14))
                break
        }
    },
}

function tone(dest: AudioNode, freq: number, at: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
    const o = ctx!.createOscillator()
    const g = ctx!.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, at)
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, at + dur)
    g.gain.setValueAtTime(vol, at)
    g.gain.exponentialRampToValueAtTime(0.001, at + dur)
    o.connect(g).connect(dest)
    o.start(at)
    o.stop(at + dur + 0.02)
}

function noise(dest: AudioNode, at: number, dur: number, vol: number) {
    const s = ctx!.createBufferSource()
    s.buffer = noiseBuffer
    const f = ctx!.createBiquadFilter()
    f.type = 'highpass'
    f.frequency.value = 6000
    const g = ctx!.createGain()
    g.gain.setValueAtTime(vol, at)
    g.gain.exponentialRampToValueAtTime(0.001, at + dur)
    s.connect(f).connect(g).connect(dest)
    s.start(at)
    s.stop(at + dur)
}

// ---------------------------------------------------------------- music

// "Hedgehog Hoedown", 8 bars of eighth notes, MIDI note numbers, 0 = rest
const MELODY = [
    72, 76, 79, 76, 72, 76, 79, 81, 79, 0, 76, 0, 72, 74, 76, 0, 77, 81, 84, 81, 77, 81, 84, 86, 84, 0, 81, 0, 79, 0, 0, 0,
    76, 79, 84, 79, 76, 79, 84, 83, 81, 0, 77, 0, 74, 76, 77, 0, 79, 77, 76, 74, 72, 74, 76, 79, 72, 0, 67, 0, 72, 0, 0, 0,
]
// Quarter notes
const BASS = [48, 55, 52, 55, 48, 55, 52, 55, 53, 60, 57, 60, 48, 55, 52, 55, 45, 52, 48, 52, 50, 57, 53, 57, 43, 50, 47, 50, 48, 55, 48, 0]
const STEP = 60 / 120 / 2 // eighth notes at 120bpm

const midi = (n: number) => 440 * 2 ** ((n - 69) / 12)

function startMusic() {
    let step = 0
    let nextTime = ctx!.currentTime + 0.1
    setInterval(() => {
        if (!ctx) return
        while (nextTime < ctx.currentTime + 0.15) {
            const m = MELODY[step % MELODY.length]
            if (m) tone(musicGain, midi(m), nextTime, STEP * 0.9, 'square', 0.07)
            if (step % 2 === 0) {
                const b = BASS[(step / 2) % BASS.length]
                if (b) tone(musicGain, midi(b), nextTime, STEP * 1.8, 'triangle', 0.22)
            } else {
                noise(musicGain, nextTime, 0.03, 0.04)
            }
            nextTime += STEP
            step++
        }
    }, 30)
}
