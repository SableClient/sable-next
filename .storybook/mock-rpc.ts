import { faker } from '@faker-js/faker/locale/en';
import generatedShapes from 'virtual:rpc-shapes';

import { createRpc, type Rpc, type RpcMethods } from '#src/generated/protocol';
import type { RpcShapes, Shape } from './generated-mocks';

export type RpcOverrides = Partial<{ [M in keyof RpcMethods]: Awaited<ReturnType<RpcMethods[M]>> }>;

const shapes = generatedShapes as RpcShapes;
const SERVER = 'example.org';
const TIMESTAMP = Date.UTC(2026, 10, 21, 18, 0);

function hash(text: string): number {
  let value = 0;
  for (const character of text) value = (value * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(value);
}

function fakeString(key: string): string {
  if (key.endsWith('user_id') || key === 'sender' || key === 'user') {
    return `@${faker.internet.username().toLowerCase()}:${SERVER}`;
  }
  if (key.endsWith('room_id') || key === 'room')
    return `!${faker.string.alphanumeric(18)}:${SERVER}`;
  if (key.endsWith('event_id')) return `$${faker.string.alphanumeric(43)}`;
  if (key.endsWith('device_id')) return faker.string.alphanumeric({ length: 10, casing: 'upper' });
  if (key.includes('url') || key.includes('avatar'))
    return `mxc://${SERVER}/${faker.string.alphanumeric(24)}`;
  if (key.includes('name')) return faker.person.fullName();
  if (key.includes('alias')) return `#${faker.word.noun()}:${SERVER}`;
  if (key.includes('topic') || key.includes('body') || key.includes('description')) {
    return faker.lorem.sentence();
  }
  if (key.includes('email')) return faker.internet.email();
  return faker.lorem.word();
}

function fakeNumber(key: string): number {
  if (key.endsWith('_ts') || key.includes('timestamp') || key.endsWith('_at')) return TIMESTAMP;
  return faker.number.int({ min: 0, max: 12 });
}

function fake(shape: Shape, key: string, depth: number): unknown {
  switch (shape.kind) {
    case 'string':
      return fakeString(key);
    case 'number':
      return fakeNumber(key);
    case 'boolean':
      return faker.datatype.boolean();
    case 'null':
    case 'unknown':
      return null;
    case 'literal':
      return shape.value;
    case 'union': {
      const present = shape.of.filter((member) => member.kind !== 'null');
      if (present.length === 0 || (depth > 4 && present.length < shape.of.length)) return null;
      return fake(present[0], key, depth);
    }
    case 'tuple':
      return shape.of.map((member) => fake(member, key, depth + 1));
    case 'array':
      return depth > 3 ? [] : [fake(shape.of, key, depth + 1), fake(shape.of, key, depth + 1)];
    case 'record':
      return {};
    case 'ref':
      return fake(shapes.defs[shape.id], key, depth + 1);
    case 'object':
      return Object.fromEntries(
        Object.entries(shape.fields).map(([field, value]) => [field, fake(value, field, depth)])
      );
  }
}

export function mockResult(method: keyof RpcMethods): unknown {
  const shape = shapes.methods[method] as Shape | undefined;
  if (!shape) return null;
  faker.seed(hash(method));
  return fake(shape, method.split('.').at(-1) ?? method, 0);
}

export function mockRpc(overrides: RpcOverrides = {}): Rpc {
  return createRpc((method) =>
    Promise.resolve(method in overrides ? overrides[method] : mockResult(method))
  );
}
