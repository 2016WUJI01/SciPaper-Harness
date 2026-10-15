/** Real Zod and JSON-schema fixtures exercise the private tool-input projection vocabulary. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { structured, valueSchema } from '../src/tools.ts'

const project = (schema: z.ZodType) => valueSchema(z.toJSONSchema(schema, { io: 'input', reused: 'inline', cycles: 'throw' }))

describe('research input schema projection', () => {
  it('projects null, tuples and literal discriminants without changing validation', () => {
    expect(project(z.null())).toEqual({ type: 'null' })
    expect(project(z.tuple([z.string()]))).toEqual({ type: 'array', items: { type: 'string' } })
    expect(project(z.literal('ready'))).toEqual({ type: 'string', const: 'ready' })
    expect(project(z.literal(false))).toEqual({ type: 'boolean', const: false })
    expect(project(z.union([z.object({ kind: z.literal('a') }), z.object({ kind: z.literal('b') })])))
      .toEqual({ oneOf: [
        { type: 'object', properties: { kind: { type: 'string', const: 'a', required: true } }, additionalProperties: true },
        { type: 'object', properties: { kind: { type: 'string', const: 'b', required: true } }, additionalProperties: true },
      ] })
  })

  it('merges overlapping alternatives and keeps only universally required properties', () => {
    const source: z.core.JSONSchema.JSONSchema = { anyOf: [
      { type: 'object', required: ['common', 'flag'], properties: { common: { type: 'string' }, flag: true, mixed: false, count: { type: 'integer' } } },
      { type: 'object', required: ['common'], properties: { common: { type: 'string' }, flag: true, mixed: { type: 'number' }, count: { type: 'number' } } },
    ] }
    expect(valueSchema(source)).toEqual({ type: 'object', additionalProperties: true, properties: {
      common: { type: 'string', required: true }, flag: { type: 'json' }, mixed: { type: 'json' },
      count: { oneOf: [{ type: 'integer' }, { type: 'number' }] },
    } })
    expect(valueSchema({ anyOf: [{ type: 'object' }, { type: 'object', properties: { value: { type: 'string', const: 'one' } } }] }))
      .toEqual({ type: 'object', properties: { value: { type: 'string' } }, additionalProperties: true })
  })

  it('does not treat equal or missing literals and unrequired discriminants as disjoint', () => {
    for (const [left, right] of [
      [{ type: 'string', const: 'same' }, { type: 'string', const: 'same' }],
      [{ type: 'string', const: 'one' }, { type: 'string' }],
      [true, { type: 'string' }],
      [{ type: 'string' }, true],
    ] satisfies Array<Array<z.core.JSONSchema.JSONSchema | boolean>>) {
      expect(valueSchema({ anyOf: [
        { type: 'object', required: ['kind'], properties: { kind: left! } },
        { type: 'object', required: ['kind'], properties: { kind: right! } },
      ] })).toHaveProperty('type', 'object')
    }
    expect(valueSchema({ anyOf: [{ type: 'object', required: ['kind'] }, { type: 'object' }] }))
      .toEqual({ type: 'object', properties: {}, additionalProperties: true })
  })

  it('supports permissive JSON schemas and reports unsupported schema vocabulary at registration', () => {
    expect(valueSchema(true)).toEqual({ type: 'json' })
    expect(valueSchema({ type: 'array' })).toEqual({ type: 'array' })
    expect(valueSchema({ type: 'object' })).toEqual({ type: 'object', properties: {}, additionalProperties: true })
    expect(valueSchema({ oneOf: [{ type: 'string' }, { type: 'null' }] })).toEqual({ oneOf: [{ type: 'string' }, { type: 'null' }] })
    expect(() => valueSchema({ anyOf: [] })).toThrow('needs at least two alternatives')
    expect(() => valueSchema({ oneOf: [{ type: 'string' }] })).toThrow('needs at least two alternatives')
    expect(() => valueSchema({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] })).toThrow('unsupported heterogeneous array items')
    expect(() => valueSchema({})).toThrow('no supported JSON type')
    expect(() => structured('not-a-command', 'field', '')).toThrow('Unknown research action')
    expect(() => structured('claim', 'not-a-field', '')).toThrow('Unknown claim field')
  })
})
