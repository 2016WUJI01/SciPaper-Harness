import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV5Header, assertReleasedV5Relationships, releasedV5SessionFormatCodec, restoreReleasedV5Artifact, sessionFormatV4ToV5 } from '../src/index.ts'

const header: SessionFormatHeader = { version: 5, id: 'local', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const fact: SessionFormatEvent = { type: 'feedback/record', seq: 0, time: 2, data: { text: 'retained' } }
const marker = (data: SessionFormatEvent['data']): SessionFormatEvent => ({
  type: 'session-log-deepseek/delivery-accepted', seq: 1, time: 3, data,
})
const known = new Set([fact.type, 'session/end-seed', 'session-log-deepseek/delivery-accepted'])

describe('V5 physical header admission', () => {
  it.each([null, [], {}, { ...header, version: 4 }])('refuses non-V5 headers without decoding event rows: %j', (value) => {
    expect(() => { assertReleasedV5Header(value) }).toThrow('expected format v5 header')
    expect(() => releasedV5SessionFormatCodec.decodeHeader(value)).toThrow('expected format v5 physical header')
    expect(() => releasedV5SessionFormatCodec.createDecoder(value, 'strict')).toThrow('expected format v5 physical header')
  })

  it.each([null, 'local', [], { kind: 'local', extra: true }, { kind: 'ssh' }, { kind: 'ssh', host: '' },
    { kind: 'ssh', host: '  ' }, { kind: 'ssh', host: 4 }, { kind: 'ssh', host: 'lab', extra: true }, { kind: 'remote' },
  ])('rejects malformed execution identity: %j', (execution) => {
    expect(() => { assertReleasedV5Header({ ...header, execution }) }).toThrow('format v5 execution')
  })

  it.each([undefined, { kind: 'local' }, { kind: 'ssh', host: 'lab' }] as const)(
    'normalizes and decodes execution identity without a cwd: %j', (execution) => {
      const logical = { ...header, ...(execution === undefined ? {} : { execution }) }
      const expected = { ...header, execution: execution ?? { kind: 'local' } }
      const physical = releasedV5SessionFormatCodec.encodeHeader(logical, 0)
      expect(releasedV5SessionFormatCodec.decodeHeader(physical)).toEqual(expected)
      const decoder = releasedV5SessionFormatCodec.createDecoder(physical, 'strict')
      const collector = new SessionFormatEventCollector()
      decoder.decodeRow(releasedV5SessionFormatCodec.encodeEvent(fact), collector)
      expect(decoder.header).toEqual(expected)
      expect(decoder.finish(collector)).toBe(0)
      expect(collector.values).toEqual([fact])
    },
  )

  it('preserves local paths and rejects malformed local or SSH cwd values', () => {
    const local = { ...header, cwd: process.platform === 'win32' ? 'C:\\work' : '/work' }
    expect(releasedV5SessionFormatCodec.decodeHeader(releasedV5SessionFormatCodec.encodeHeader(local, 0)))
      .toEqual({ ...local, execution: { kind: 'local' } })
    expect(() => { assertReleasedV5Header({ ...header, cwd: 'relative' }) }).toThrow('cwd must be absolute')
    for (const cwd of [1, 'relative', 'C:\\work']) {
      expect(() => { assertReleasedV5Header({ ...header, cwd, execution: { kind: 'ssh', host: 'lab' } }) })
        .toThrow('SSH cwd must be absolute POSIX')
    }
  })
})

describe('V4 to V5 event preservation', () => {
  function stage(isSeeded = false, sourceInheritedEventCount?: number) {
    const sourceHeader = { ...header, version: 4, isSeeded }
    return sessionFormatV4ToV5.createStage({ sourceHeader,
      targetHeader: sessionFormatV4ToV5.migrateHeader(sourceHeader), sourceInheritedEventCount, sourceKind: 'decoded' })
  }

  it('keeps concurrent stage state independent and preserves expanded runs by identity', () => {
    const inherited = stage(true)
    const local = stage(false, 0)
    const a = new SessionFormatEventCollector()
    const b = new SessionFormatEventCollector()
    expect(inherited.headerInheritedEventCount).toBeUndefined()
    expect(local.headerInheritedEventCount).toBe(0)
    expect(stage(true).finish(a)).toBe(0)
    expect(stage(true, 7).finish(a)).toBe(7)
    inherited.transformRun({ runType: 'identity', eventCount: 1, firstSeq: 0, *expand() { yield fact } }, a)
    local.transformEvent(fact, b)
    inherited.transformEvent({ type: 'session/end-seed', seq: 1, time: 3, data: {} }, a)
    inherited.transformEvent({ type: 'session/end-seed', seq: 2, time: 4, data: null }, a)
    inherited.transformEvent({ type: 'session/end-seed', seq: 3, time: 5, data: { inherited: true } }, a)
    expect(inherited.finish(a)).toBe(3)
    expect(local.finish(b)).toBe(0)
    expect(a.values[0]).toBe(fact)
    expect(b.values).toEqual([fact])
    expect(() => sessionFormatV4ToV5.migrateHeader(header)).toThrow('expected format v4 header')
    expect(() => { sessionFormatV4ToV5.validateTargetHeader({ ...header, version: 4 }) }).toThrow('expected format v5 header')
  })
})

describe('V5 delivery ownership', () => {
  function artifact(data: SessionFormatEvent['data']): SessionFormatArtifact {
    return { header, inheritedEventCount: 0, events: [fact, marker(data)] }
  }

  it.each([
    [null, 'data must be an object'],
    [{ sessionFormatVersion: -1 }, 'sessionFormatVersion'],
    [{ sessionFormatVersion: 5, throughSeq: 1, sessionId: 'local' }, 'must precede'],
    [{ sessionFormatVersion: 5, throughSeq: -1, sessionId: 'local' }, 'throughSeq'],
    [{ sessionFormatVersion: 5, throughSeq: 0, sessionId: '' }, 'nonempty'],
    [{ sessionFormatVersion: 5, throughSeq: 0, sessionId: 1 }, 'nonempty'],
    [{ sessionFormatVersion: 5, throughSeq: 0, sessionId: 'other' }, 'wrong Session'],
  ] as const)('rejects invalid current markers: %j', (data, diagnostic) => {
    for (const validate of [restoreReleasedV5Artifact, assertReleasedV5Relationships]) {
      expect(() => { validate(artifact(data), known) }).toThrow(diagnostic)
    }
  })

  it('preserves current and historical markers without changing their payloads', () => {
    for (const data of [{}, { sessionFormatVersion: 3, sessionId: 'ancestor', throughSeq: 500 },
      { sessionFormatVersion: 5, sessionId: 'local', throughSeq: 0 }]) {
      const source = artifact(data)
      const before = JSON.stringify(source)
      expect(restoreReleasedV5Artifact(source, known)).toBe(source)
      expect(() => { assertReleasedV5Relationships(source, known) }).not.toThrow()
      expect(JSON.stringify(source)).toBe(before)
    }
    const source = artifact(null)
    expect(() => { assertReleasedV5Relationships(source, new Set([fact.type])) }).not.toThrow()
  })

  it('allows foreign markers only inside a parent inherited prefix', () => {
    const source = artifact({ sessionFormatVersion: 5, sessionId: 'ancestor', throughSeq: 0 })
    const seed = { type: 'session/end-seed', seq: 2, time: 4, data: { inherited: true } }
    const inherited = { ...source, header: { ...header, isSeeded: true, parentSession: 'ancestor' },
      inheritedEventCount: 2, events: [...source.events, seed] }
    expect(restoreReleasedV5Artifact(inherited, known)).toBe(inherited)
    expect(() => { assertReleasedV5Relationships(inherited, known) }).not.toThrow()
    expect(() => restoreReleasedV5Artifact({ ...inherited, header: { ...header, isSeeded: true } }, known))
      .toThrow('wrong Session')
    const after = { ...inherited, inheritedEventCount: 1,
      events: [fact, { ...seed, seq: 1 }, { ...source.events[1]!, seq: 2 }] }
    expect(() => restoreReleasedV5Artifact(after, known)).toThrow('wrong Session')
  })
})
