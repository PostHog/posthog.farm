type Child = Node | string | number | null | undefined | false
type Attrs = Record<string, unknown>

/** Tiny hyperscript helper: h('div', { class: 'x', onclick }, 'text', child) */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
        else if (k in el && k !== 'class' && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v
        else el.setAttribute(k === 'className' ? 'class' : k, v === true ? '' : String(v))
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue
        el.append(c instanceof Node ? c : String(c))
    }
    return el
}

export function fmtCountdown(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000))
    const hh = String(Math.floor(s / 3600)).padStart(2, '0')
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
    const ss = String(s % 60).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
}

export function timeAgo(at: number, now = Date.now()): string {
    const s = Math.max(0, Math.floor((now - at) / 1000))
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    const d = Math.floor(s / 86400)
    return d === 1 ? 'yesterday' : `${d} days ago`
}

export function flag(country: string | null | undefined): string {
    if (!country || !/^[A-Z]{2}$/.test(country) || country === 'XX' || country === 'T1') return '🌍'
    return String.fromCodePoint(...[...country].map((c) => 0x1f1a5 + c.charCodeAt(0)))
}

export function fmtNumber(n: number): string {
    return n.toLocaleString('en-US')
}

export function article(word: string): string {
    return /^[AEIOU]/i.test(word) ? 'AN' : 'A'
}
