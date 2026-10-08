import { test, expect, mock } from 'claude-code/testing'
import { hud } from './register'

// The plugin's own AbovePrompt hook reads live state, so the tree is validated in a Pane slot instead:
// same element tables and prop rules, with this test supplying the data. (The real AbovePrompt path is
// checked against a live session's debug log.)
const BAND: any = {
  component: 'Pane',
  requestId: 'hud-test',
  props: { id: 'hud-test', title: 'hud', bodyColumns: 120, bodyRows: 40, isFocused: false, scroll: { bodyRows: 40 } },
}
const cat = (name: string, tokens: number, color: string, kind = 'used') => ({ name, tokens, color, kind })
const SNAP: any = {
  cats: [
    cat('System prompt', 4800, 'permission'),
    cat('Tools', 27000, 'claude'),
    cat('Agents', 257, 'suggestion'),
    cat('Messages', 190000, 'warning'),
    cat('Compact buffer', 33000, 'subtle', 'buffer'),
    cat('Free space', 715000, 'inactive', 'free'),
  ],
  used: 252000, window: 1_000_000, threshold: 967000, percent: 25, err: null,
}
const DATA: any = {
  limits: [
    { kind: 'five_hour', percentUsed: 3.46, resetsAt: '2026-10-06T22:00:00Z' },
    { kind: 'seven_day', percentUsed: 1.2, resetsAt: '2026-10-13T22:00:00Z' },
  ],
  t: { chat: { i: 362000, o: 87000 }, all: { i: 1_040_000, o: 338000 }, at: 0 },
  err: null,
  now: Date.parse('2026-10-06T19:00:00Z'),
  cols: 120,
}

test('both cards draw, in order, on every surface and state', async ($, on) => {
  mock.clock(on)
  let snap: any = SNAP
  let data: any = DATA
  on('ui.render', { component: 'Pane', requestId: 'hud-test' }, async ($: any, e: any) => hud($.ui.resolve(e), data, snap))
  const states: [any, any][] = [
    [SNAP, DATA],
    [null, DATA], // no breakdown yet: usage card alone
    [{ ...SNAP, cats: [], err: 'boom' }, DATA],
    [{ ...SNAP, threshold: null }, { ...DATA, limits: [], t: null }],
    [SNAP, { ...DATA, cols: 60 }], // narrow: token block stacks above the bars
  ]
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const [s, d] of states) {
      snap = s
      data = d
      const ui = await $.ui.mount({ plugin: 'prompt-hud', surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: /usage/ })).toBeDefined()
      if (s !== null) expect(await ui.find({ type: 'Text', text: /context/ })).toBeDefined()
      await ui.unmount()
    }
  }
})
