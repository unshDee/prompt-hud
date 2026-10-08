import { test, expect } from 'claude-code/testing'
import { fmt, fmtK, share, until, segments, catLabel, hue } from './register'

test('formats and segments', () => {
  expect(fmt(302_000)).toBe('302k')
  expect(fmt(1_040_000)).toBe('1.0M')
  expect(fmtK(4200)).toBe('4.2k')
  expect(fmtK(1_000_000)).toBe('1M')
  expect(share(3, 1000)).toBe('<1%')
  expect(share(50_000, 1_000_000)).toBe('5%')
  expect(until('2026-10-09T14:00:00Z', Date.parse('2026-10-06T10:00:00Z'))).toBe('3d 4h')
  expect(catLabel({ name: 'MCP tools', kind: 'used' })).toBe('mcp tools')
  expect(catLabel({ name: 'Free space', kind: 'free' })).toBe('free')
  expect(hue({ color: 'permission', kind: 'free' })).toBe('subtle')

  const cats = [
    { tokens: 100, color: 'claude', kind: 'used' as const },
    { tokens: 300, color: 'permission', kind: 'used' as const },
    { tokens: 600, color: 'inactive', kind: 'free' as const },
  ]
  const segs = segments(cats, 250)
  expect(segs.map(s => !!s.isMark)).toEqual([false, false, true, false, false])
  expect(Math.round(segs.reduce((a, s) => a + s.pct, 0))).toBe(100)
  expect(segments(cats, null)).toHaveLength(3)
  expect(segments([], 1)).toEqual([])
})
