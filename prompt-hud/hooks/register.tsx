import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Cat, Limit, Pair, Snap, Tokens } from '../types'

const limits = atom({ plugin: 'prompt-hud', key: 'limits' } as const, [])
const tokens = atom({ plugin: 'prompt-hud', key: 'tokens' } as const, null)
const error = atom({ plugin: 'prompt-hud', key: 'error' } as const, null)
const snap = atom({ plugin: 'prompt-hud', key: 'snap' } as const, null)

const DAY = 864e5
const TTL = 60_000

// Read-only aggregate over the transcripts. Streamed messages repeat one id with a
// growing count, so the last row per (session, id) wins. `all` counts rows since $s
// (the weekly window start); `chat` counts every row of session $sid. Input is
// uncached + cache-write tokens; cache reads are not counted.
export const JQ = `reduce (inputs | select(contains("\\"output_tokens\\"")) | (try fromjson catch empty)
  | select(.type == "assistant" and .message.usage != null)
  | (input_filename | ltrimstr($b) | split("/")) as $p
  | {s: (if ($p | length) > 2 then $p[1] else ($p[1] | sub("\\\\.jsonl$"; "")) end), m: (.message.id // .uuid),
     w: ((.timestamp // "") >= $s),
     i: ((.message.usage.input_tokens // 0) + (.message.usage.cache_creation_input_tokens // 0)),
     o: (.message.usage.output_tokens // 0)}
) as $r ({}; .[$r.s + "|" + $r.m] = $r)
| reduce .[] as $r ({all: {i: 0, o: 0}, chat: {i: 0, o: 0}};
    (if $r.w then .all.i += $r.i | .all.o += $r.o else . end)
    | (if $r.s == $sid then .chat.i += $r.i | .chat.o += $r.o else . end))`

export const fmt = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B`
  : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
  : n >= 1e3 ? `${Math.round(n / 1e3)}k`
  : `${n}`

export const until = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return 'now'
  const h = Math.floor(ms / 36e5)
  const m = Math.floor((ms % 36e5) / 6e4)
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

// Split `width` cells between two segments of a total; rounding never overfills.
export const cells = (a: number, b: number, total: number, width: number): [number, number] => {
  if (total <= 0) return [0, 0]
  const x = Math.round((a / total) * width)
  const y = Math.min(width - x, Math.round((b / total) * width))
  return [x, y]
}

export const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length))

export const summary = (l5: Limit | undefined, l7: Limit | undefined, chat: Pair, all: Pair): string =>
  `5h ${l5 ? Math.round(l5.percentUsed) + '%' : '—'} · wk ${l7 ? Math.round(l7.percentUsed) + '%' : '—'}` +
  ` · chat ↑${fmt(chat.i)} ↓${fmt(chat.o)} · all ↑${fmt(all.i)} ↓${fmt(all.o)}`

// colours are theme keys, so light and dark both read
const tone = (p: number) => (p >= 90 ? 'error' : p >= 70 ? 'warning' : 'success')


let busy = false
let lastScan = 0


async function scan($: any, resetsAt: string) {
  const home = await $.env.get('HOME')
  const sid = await $.session.id()
  const base = `${home}/.claude/projects/`
  const start = Date.parse(resetsAt) - 7 * DAY // the weekly window began 7 days before its reset
  const now = await $.clock.now()
  const mins = Math.ceil((now - start) / 6e4) + 1
  const found = await $.process.run(['find', base, '-type', 'f', '-name', '*.jsonl', '-mmin', `-${mins}`])
  const files = found.stdout.split('\n').filter(Boolean)
  let out = { all: { i: 0, o: 0 }, chat: { i: 0, o: 0 } }
  if (files.length) {
    const r = await $.process.run(
      ['jq', '-R', '-n', '-c', '--arg', 's', new Date(start).toISOString(), '--arg', 'b', base, '--arg', 'sid', sid, JQ, ...files],
      { timeoutMs: 120_000 },
    )
    if (r.exitCode !== 0) throw new Error(`jq exit ${r.exitCode}`)
    out = JSON.parse(r.stdout || '{}')
  }
  await update($, tokens, () => ({ chat: out.chat, all: out.all, at: now }))
  await update($, error, () => null)
}

// Never awaited by a hook: a slow scan only delays its own numbers.
async function refreshUsage($: any) {
  if (busy) return
  busy = true
  try {
    const u = await $.session.usage()
    if (u.rateLimits.length) await update($, limits, () => u.rateLimits)
    const wk = u.rateLimits.find((l: Limit) => l.kind === 'seven_day')
    if (wk?.resetsAt && (await $.clock.now()) - lastScan >= TTL) {
      lastScan = await $.clock.now()
      await scan($, wk.resetsAt)
    }
  } catch (err) {
    await update($, error, () => String((err as Error)?.message ?? err))
  } finally {
    busy = false
  }
}


const NAMES: [RegExp, string][] = [
  [/system prompt/i, 'system prompt'],
  [/mcp/i, 'mcp tools'],
  [/tools/i, 'tools'],
  [/agents/i, 'agents'],
  [/memory/i, 'memory files'],
  [/skills/i, 'skills'],
  [/messages/i, 'messages'],
]

export const catLabel = (c: Pick<Cat, 'name' | 'kind'>): string =>
  c.kind === 'free' ? 'free' : c.kind === 'buffer' ? 'compact buffer' : (NAMES.find(([re]) => re.test(c.name))?.[1] ?? c.name.toLowerCase())

// The engine's own theme colour per row, as /context draws it; free space is always muted.
export const hue = (c: Pick<Cat, 'color' | 'kind'>): string => (c.kind === 'free' ? 'subtle' : c.color || 'subtle')

export const fmtK = (n: number): string =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k` : `${n}`

export const share = (n: number, of: number): string => {
  const p = (n / of) * 100
  return n > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
}

export type Seg = { color: string; pct: number; isMark?: boolean }

// Percent-width segments in category order; the compaction threshold becomes a 1-cell marker
// splitting the category it falls in. Widths are percentages, so the bar fills any container.
export const segments = (cats: Pick<Cat, 'tokens' | 'color' | 'kind'>[], threshold: number | null): Seg[] => {
  const total = cats.reduce((a, c) => a + c.tokens, 0)
  if (total <= 0) return []
  const out: Seg[] = []
  let at = 0
  let marked = threshold === null
  for (const c of cats) {
    const from = at
    const to = at + c.tokens
    at = to
    const color = hue(c)
    if (!marked && threshold! >= from && threshold! < to) {
      if (threshold! > from) out.push({ color, pct: ((threshold! - from) / total) * 100 })
      out.push({ color: 'warning', pct: 0, isMark: true })
      if (to > threshold!) out.push({ color, pct: ((to - threshold!) / total) * 100 })
      marked = true
    } else if (c.tokens > 0) out.push({ color, pct: (c.tokens / total) * 100 })
  }
  return out
}

async function refreshContext($: any) {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const b = u.context.breakdown
    if (!b) {
      // no breakdown yet (fresh session): fall back to the status line's figures
      const used = u.context.tokens ?? 0
      await update($, snap, () => ({ cats: [], used, window: u.context.window, threshold: null, percent: u.context.percent ?? 0, err: null }))
      return
    }
    await update($, snap, () => ({
      cats: b.categories
        .filter((c: Cat) => c.kind !== 'deferred' && (c.tokens > 0 || c.kind === 'free'))
        .map((c: Cat) => ({ name: c.name, tokens: c.tokens, kind: c.kind, color: c.color })),
      used: b.totalTokens,
      window: b.rawMaxTokens,
      threshold: b.isAutoCompactEnabled ? (b.autoCompactThreshold ?? null) : null,
      percent: b.percentage,
      err: null,
    }))
  } catch (err) {
    await update($, snap, s => ({ cats: [], used: 0, window: 0, threshold: null, percent: 0, ...s, err: String((err as Error)?.message ?? err) }))
  }
}


export function contextCard({ Box, Text }: any, s: Snap) {
  // the bar is percent-width empty Boxes with a background: it fills the card, whatever the font does
  const cats = s.cats
  const segs = segments(cats, s.threshold === null || !s.window ? null : s.threshold)
  if (!cats.length) {
    const p = s.window ? Math.min(100, (s.used / s.window) * 100) : 0
    segs.push({ color: 'claude', pct: p }, { color: 'subtle', pct: 100 - p })
  }

  const tone = s.percent >= 85 ? 'error' : s.percent >= 60 ? 'warning' : 'success'
  const head = s.threshold === null ? 'auto-compact off' : `compacts at ${fmtK(s.threshold)}`

  const mine = (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="claude" borderDimColor width="100%">
      <Box justifyContent="space-between">
        <Box>
          <Text bold color="claude">✻ </Text>
          <Text bold>context</Text>
        </Box>
        <Box columnGap={1}>
          <Text bold>{fmtK(s.used)}</Text>
          <Text dimColor>of {fmtK(s.window)} · {head}</Text>
          <Text bold inverse color={tone}> {Math.round(s.percent)}% </Text>
        </Box>
      </Box>
      <Box width="100%" height={1}>
        {segs.map((r, i) => (
          r.isMark
            ? <Box key={String(i)} width={1} height={1} flexShrink={0} backgroundColor={r.color} />
            : <Box key={String(i)} width={0} flexGrow={Math.max(1, Math.round(r.pct * 100))} minWidth={1} height={1} backgroundColor={r.color} />
        ))}
      </Box>
      <Box columnGap={2} flexWrap="wrap">
        {cats.map(c => (
          <Box key={c.name} columnGap={1}>
            <Text color={hue(c)}>●</Text>
            <Text>{catLabel(c)}</Text>
            <Text bold>{fmtK(c.tokens)}</Text>
            <Text dimColor>{share(c.tokens, s.window)}</Text>
          </Box>
        ))}
        {s.err ? <Text color="error">breakdown unavailable: {s.err}</Text> : cats.length ? <Text dimColor italic>est.</Text> : null}
      </Box>
    </Box>
  )
  return mine
}


export type ViewData = { limits: Limit[]; t: Tokens | null; err: string | null; now: number; cols: number }

// One card: token numbers on the left, the 5h and week bars on the right, row for row.
export function usageCard({ Box, Text }: any, d: ViewData, hasAbove: boolean) {
  const l5 = d.limits.find(l => l.kind === 'five_hour')
  const l7 = d.limits.find(l => l.kind === 'seven_day')
  const { t, err, now } = d
  const LABEL = 6, UP = 9, DOWN = 9, PCT = 5, RESET = 13
  const stacked = d.cols < 90

  const cell = (w: number, child: any) => <Box width={w} flexShrink={0}>{child}</Box>
  const label = (name: string) => cell(LABEL, <Text bold color="claude">{name}</Text>)

  const tokenRow = (name: string, p?: Pair) => (
    <Box>
      {label(name)}
      {cell(UP, <Text color="suggestion">{p ? '↑' + fmt(p.i) : '…'}</Text>)}
      {cell(DOWN, <Text color="claude">{p ? '↓' + fmt(p.o) : ''}</Text>)}
    </Box>
  )

  // the bar takes the width left over; its segments are whole-number flexGrow weights (percent widths are refused)
  const gaugeRow = (name: string, l?: Limit) => {
    if (!l) return <Box>{label(name)}<Text dimColor>—</Text></Box>
    const p = Math.min(100, Math.max(0, l.percentUsed))
    const fill = Math.round(p * 100)
    return (
      <Box columnGap={1}>
        {label(name)}
        <Box flexGrow={1} height={1}>
          {fill > 0 ? <Box width={0} flexGrow={fill} height={1} backgroundColor={tone(p)} /> : null}
          {fill < 10000 ? <Box width={0} flexGrow={10000 - fill} height={1} backgroundColor="subtle" /> : null}
        </Box>
        {cell(PCT, <Text bold color={tone(p)}>{Math.round(l.percentUsed) + '%'}</Text>)}
        {cell(RESET, <Text dimColor>{'↻ ' + until(l.resetsAt, now)}</Text>)}
      </Box>
    )
  }

  const mine = (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="claude" borderDimColor width="100%" marginTop={hasAbove ? 1 : 0}>
      <Box>
        <Text bold color="claude">✻ </Text>
        <Text bold>usage</Text>
        <Text dimColor>{'  tokens (chat, all projects this week) · plan limits'}</Text>
      </Box>
      <Box flexDirection={stacked ? 'column' : 'row'} columnGap={3}>
        <Box flexDirection="column" flexShrink={0}>
          {tokenRow('chat', t?.chat)}
          {tokenRow('all', t?.all)}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {gaugeRow('5h', l5)}
          {gaugeRow('week', l7)}
        </Box>
      </Box>
      {t ? null : (
        <Text dimColor>
          {err ? `tokens unavailable: ${err}` : l7?.resetsAt ? 'scanning transcripts…' : 'tokens need a plan with a weekly reset'}
        </Text>
      )}
    </Box>
  )
  return mine
}

// One tree, one fixed order: the context card, a row of space, the usage card. Nothing the engine
// hands back from next(e) goes in it: that placeholder is not allowed under a sized Box.
export function hud(el: any, d: ViewData, s: Snap | null) {
  const { Box } = el
  return (
    <Box flexDirection="column">
      {s === null ? null : contextCard(el, s)}
      {usageCard(el, d, s !== null)}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void refreshUsage($)
    $.clock.every(TTL, () => void refreshUsage($))
    await refreshContext($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length) await update($, limits, () => e.rateLimits)
    if (e.changed.includes('context')) await refreshContext($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const data = {
      limits: await read($, limits),
      t: await read($, tokens),
      err: await read($, error),
      now: await $.clock.now(),
      cols: e.props.bodyColumns,
    }
    return hud($.ui.resolve(e), data, await read($, snap))
  })
}
