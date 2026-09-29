import type { BotCommandDescriptionView } from '#src/generated/protocol';

import { parseMatrixLink } from '#lib/rooms/matrix-link.js';
import { splitVia } from '#lib/rooms/join-address.js';

const PRIMITIVES = [
  'string',
  'integer',
  'boolean',
  'user_id',
  'server_name',
  'room_alias',
  'room_id',
  'event_id',
] as const;

export type PrimitiveType = (typeof PRIMITIVES)[number];

export type RoomReference = {
  type: 'room_id' | 'event_id';
  id: string;
  via?: string[];
  event_id?: string;
};

export type LiteralValue = string | number | boolean | RoomReference;
export type ArgumentValue = LiteralValue | LiteralValue[];

export type ScalarSchema =
  | { schema_type: 'primitive'; type: PrimitiveType }
  | { schema_type: 'literal'; value: LiteralValue };

export type ItemSchema = ScalarSchema | { schema_type: 'union'; variants: ScalarSchema[] };

export type ParameterSchema = ItemSchema | { schema_type: 'array'; items: ItemSchema };

export type BotCommandParameter = {
  key: string;
  schema: ParameterSchema;
  description: string | null;
  optional: boolean;
  defaultValue: ArgumentValue | null;
  flag: string | null;
};

export type BotCommand = {
  sender: string;
  senderName: string | null;
  senderAvatar: string | null;
  command: string;
  aliases: string[];
  description: string | null;
  parameters: BotCommandParameter[];
  tailParameter: string | null;
};

export type BotCommandInvocation = {
  command: string;
  arguments: Record<string, ArgumentValue>;
};

export type ArgumentDraft = string | string[] | boolean;
export type ArgumentDrafts = Record<string, ArgumentDraft>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  const body = record(value)?.['m.text'];
  if (!Array.isArray(body)) return null;
  for (const entry of body) {
    const found = record(entry)?.body;
    if (typeof found === 'string' && found !== '') return found;
  }
  return null;
}

function roomReference(value: unknown): RoomReference | null {
  const object = record(value);
  if (!object || (object.type !== 'room_id' && object.type !== 'event_id')) return null;
  if (typeof object.id !== 'string') return null;
  return object as RoomReference;
}

function literalValue(value: unknown): LiteralValue | null {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  return roomReference(value);
}

function scalarSchema(value: unknown): ScalarSchema | null {
  const object = record(value);
  if (object?.schema_type === 'primitive') {
    const type = PRIMITIVES.find((primitive) => primitive === object.type);
    return type ? { schema_type: 'primitive', type } : null;
  }
  if (object?.schema_type === 'literal') {
    const literal = literalValue(object.value);
    return literal === null ? null : { schema_type: 'literal', value: literal };
  }
  return null;
}

function itemSchema(value: unknown): ItemSchema | null {
  const object = record(value);
  if (object?.schema_type !== 'union') return scalarSchema(value);
  if (!Array.isArray(object.variants) || object.variants.length === 0) return null;
  const variants = object.variants.map(scalarSchema);
  return variants.every((variant) => variant !== null) ? { schema_type: 'union', variants } : null;
}

function parameterSchema(value: unknown): ParameterSchema | null {
  const object = record(value);
  if (object?.schema_type !== 'array') return itemSchema(value);
  const items = itemSchema(object.items);
  return items ? { schema_type: 'array', items } : null;
}

function argumentValue(value: unknown): ArgumentValue | null {
  if (!Array.isArray(value)) return literalValue(value);
  const items = value.map(literalValue);
  return items.every((item) => item !== null) ? items : null;
}

function parameter(value: unknown): BotCommandParameter | null {
  const object = record(value);
  if (!object || typeof object.key !== 'string' || object.key === '') return null;
  const schema = parameterSchema(object.schema);
  if (!schema) return null;
  return {
    key: object.key,
    schema,
    description: text(object.description),
    optional: object.optional === true,
    defaultValue: argumentValue(object['fi.mau.default_value']),
    flag: typeof object['moe.sable.flag'] === 'string' ? object['moe.sable.flag'] : null,
  };
}

export function parseBotCommand(view: BotCommandDescriptionView): BotCommand | null {
  const content = record(view.content);
  const command = content?.command;
  if (!content || typeof command !== 'string' || command.trim() === '') return null;

  const declared: unknown[] = Array.isArray(content.parameters) ? content.parameters : [];
  const parameters = declared.map(parameter);
  if (!parameters.every((entry) => entry !== null)) return null;
  const keys = new Set(parameters.map((entry) => entry.key));
  if (keys.size !== parameters.length) return null;

  const aliases = Array.isArray(content.aliases)
    ? content.aliases.filter((alias): alias is string => typeof alias === 'string' && alias !== '')
    : [];
  const tail = content['fi.mau.tail_parameter'];

  return {
    sender: view.sender,
    senderName: view.sender_name,
    senderAvatar: view.sender_avatar,
    command: command.trim(),
    aliases,
    description: text(content.description),
    parameters,
    tailParameter: typeof tail === 'string' && keys.has(tail) ? tail : null,
  };
}

export function parseBotCommands(views: readonly BotCommandDescriptionView[]): BotCommand[] {
  const commands = new Map<string, BotCommand>();
  for (const view of views) {
    const command = parseBotCommand(view);
    if (command) commands.set(`${command.sender}\n${command.command}`, command);
  }
  return [...commands.values()];
}

export function botCommandId(command: BotCommand): string {
  return `bot:${command.sender} ${command.command}`;
}

export function botCommandNames(command: BotCommand): string[] {
  return [command.command, ...command.aliases];
}

export function matchBotCommand(
  line: string,
  commands: readonly BotCommand[]
): { command: BotCommand; args: string; rawArgs: string } | null {
  const lower = line.toLowerCase();
  let best: { command: BotCommand; args: string; rawArgs: string; length: number } | null = null;
  for (const command of commands) {
    for (const name of botCommandNames(command)) {
      const candidate = name.toLowerCase();
      if (!lower.startsWith(candidate)) continue;
      const rest = line.slice(candidate.length);
      if (rest !== '' && !/^\s/.test(rest)) continue;
      if (best && best.length >= candidate.length) continue;
      best = { command, args: rest.trim(), rawArgs: rest, length: candidate.length };
    }
  }
  return best && { command: best.command, args: best.args, rawArgs: best.rawArgs };
}

const USER_ID = /^@[^:\s]+:\S+$/;
const ROOM_ALIAS = /^#[^:\s]+:\S+$/;
const ROOM_ID = /^![^:\s]+(?::\S+)?$/;
const SERVER_NAME = /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i;
const INTEGER = /^[-+]?\d+$/;

const TRUE = new Set(['true', 'yes', 'y', 'on', '1']);
const FALSE = new Set(['false', 'no', 'n', 'off', '0']);

function roomFromInput(
  input: string
): { roomId: string; eventId: string | null; via: string[] } | null {
  if (ROOM_ID.test(input)) return { roomId: input, eventId: null, via: [] };
  const { href, via } = splitVia(input);
  const link = parseMatrixLink(href);
  if (link === null || link.kind === 'user' || !link.roomId.startsWith('!')) return null;
  return { roomId: link.roomId, eventId: link.kind === 'event' ? link.eventId : null, via };
}

function withVia(reference: RoomReference, via: string[]): RoomReference {
  return via.length > 0 ? { ...reference, via } : reference;
}

function primitive(type: PrimitiveType, input: string): LiteralValue | null {
  switch (type) {
    case 'string':
      return input;
    case 'integer': {
      if (!INTEGER.test(input)) return null;
      const value = Number(input);
      return Number.isSafeInteger(value) ? value : null;
    }
    case 'boolean': {
      const lower = input.toLowerCase();
      if (TRUE.has(lower)) return true;
      return FALSE.has(lower) ? false : null;
    }
    case 'user_id': {
      if (USER_ID.test(input)) return input;
      const link = parseMatrixLink(input);
      return link?.kind === 'user' ? link.userId : null;
    }
    case 'server_name':
      return SERVER_NAME.test(input) ? input : null;
    case 'room_alias': {
      if (ROOM_ALIAS.test(input)) return input;
      const link = parseMatrixLink(splitVia(input).href);
      return link?.kind === 'room' && link.roomId.startsWith('#') ? link.roomId : null;
    }
    case 'room_id': {
      const room = roomFromInput(input);
      if (!room || room.eventId !== null) return null;
      return withVia({ type: 'room_id', id: room.roomId }, room.via);
    }
    case 'event_id': {
      const room = roomFromInput(input);
      if (!room?.eventId) return null;
      return withVia({ type: 'event_id', id: room.roomId, event_id: room.eventId }, room.via);
    }
  }
}

export function literalLabel(value: LiteralValue): string {
  if (typeof value !== 'object') return String(value);
  return value.event_id ?? value.id;
}

function scalar(schema: ScalarSchema, input: string): LiteralValue | null {
  if (schema.schema_type === 'primitive') return primitive(schema.type, input);
  return literalLabel(schema.value).toLowerCase() === input.toLowerCase() ? schema.value : null;
}

function coerceItem(schema: ItemSchema, input: string): LiteralValue | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  if (schema.schema_type !== 'union') return scalar(schema, trimmed);
  const variants = [
    ...schema.variants.filter((variant) => variant.schema_type === 'literal'),
    ...schema.variants.filter((variant) => variant.schema_type !== 'literal'),
  ];
  for (const variant of variants) {
    const value = scalar(variant, trimmed);
    if (value !== null) return value;
  }
  return null;
}

export function itemSchemaOf(schema: ParameterSchema): ItemSchema {
  return schema.schema_type === 'array' ? schema.items : schema;
}

export function isBooleanParameter(schema: ParameterSchema): boolean {
  return schema.schema_type === 'primitive' && schema.type === 'boolean';
}

export function literalChoices(schema: ItemSchema): LiteralValue[] | null {
  if (schema.schema_type === 'literal') return [schema.value];
  if (schema.schema_type !== 'union') return null;
  if (!schema.variants.every((variant) => variant.schema_type === 'literal')) return null;
  return schema.variants.map((variant) => (variant as { value: LiteralValue }).value);
}

export function acceptsType(schema: ParameterSchema, type: PrimitiveType): boolean {
  const item = itemSchemaOf(schema);
  if (item.schema_type === 'primitive') return item.type === type;
  if (item.schema_type !== 'union') return false;
  return item.variants.some(
    (variant) => variant.schema_type === 'primitive' && variant.type === type
  );
}

function draftOf(parameter: BotCommandParameter, value: ArgumentValue | null): ArgumentDraft {
  if (isBooleanParameter(parameter.schema)) return value === true;
  if (parameter.schema.schema_type === 'array') {
    return Array.isArray(value) ? value.map(literalLabel) : [];
  }
  return value === null || Array.isArray(value) ? '' : literalLabel(value);
}

export function emptyDrafts(command: BotCommand): ArgumentDrafts {
  return Object.fromEntries(
    command.parameters.map((parameter) => [
      parameter.key,
      draftOf(parameter, parameter.defaultValue),
    ])
  );
}

function flagName(key: string): string {
  return key.replaceAll('_', '-');
}

function fillsByPosition(parameter: BotCommandParameter): boolean {
  return !isBooleanParameter(parameter.schema) || !parameter.optional;
}

export function draftsFromText(command: BotCommand, args: string): ArgumentDrafts {
  const drafts = emptyDrafts(command);
  let rest = args.trim();
  const byName = new Map(
    command.parameters.flatMap((parameter) => [
      [flagName(parameter.key), parameter] as const,
      ...(parameter.flag?.startsWith('--')
        ? [[flagName(parameter.flag.slice(2)), parameter] as const]
        : []),
    ])
  );
  const named = new Set<string>();
  const shift = (): string => {
    const [word = ''] = rest.split(/\s/, 1);
    rest = rest.slice(word.length).trimStart();
    return word;
  };
  const words = (): string[] => (rest === '' ? [] : rest.split(/\s+/));
  const takeNamed = (): boolean => {
    const match = /^--([\w-]+)(?:=(\S*))?(?=\s|$)/.exec(rest);
    const parameter = match ? byName.get(flagName(match[1])) : undefined;
    if (!match || !parameter) return false;
    rest = rest.slice(match[0].length).trimStart();
    named.add(parameter.key);
    const value = match.at(2);
    if (isBooleanParameter(parameter.schema)) {
      drafts[parameter.key] = value === undefined || primitive('boolean', value) === true;
    } else if (parameter.schema.schema_type === 'array') {
      drafts[parameter.key] = [...(drafts[parameter.key] as string[]), value ?? shift()];
    } else {
      drafts[parameter.key] = value ?? shift();
    }
    return true;
  };

  const positional = command.parameters.filter(fillsByPosition);
  let next = 0;
  while (rest !== '') {
    if (takeNamed()) continue;
    const index = positional.findIndex((parameter, at) => at >= next && !named.has(parameter.key));
    if (index === -1) break;
    const parameter = positional[index];
    next = index + 1;

    if (parameter.key === command.tailParameter) {
      drafts[parameter.key] = rest;
      break;
    }
    if (parameter.schema.schema_type === 'array') {
      const needed = positional
        .slice(next)
        .filter((later) => !later.optional && !named.has(later.key)).length;
      const available = words().findIndex((word) => word.startsWith('--'));
      const count = Math.max(0, (available === -1 ? words().length : available) - needed);
      drafts[parameter.key] = Array.from({ length: count }, shift);
      continue;
    }
    const word = shift();
    drafts[parameter.key] = isBooleanParameter(parameter.schema)
      ? primitive('boolean', word) === true
      : word;
  }
  return drafts;
}

export type InvocationResult =
  | { ok: true; invocation: BotCommandInvocation; body: string }
  | { ok: false; errors: Record<string, 'required' | 'invalid'> };

function bodyWord(value: LiteralValue): string {
  const label = literalLabel(value);
  return /\s/.test(label) ? JSON.stringify(label) : label;
}

function named(parameter: BotCommandParameter, word: string): string {
  return parameter.flag ? `${parameter.flag}=${word}` : word;
}

export function buildInvocation(
  command: BotCommand,
  drafts: ArgumentDrafts,
  prefix = '/'
): InvocationResult {
  const args: Record<string, ArgumentValue> = {};
  const errors: Record<string, 'required' | 'invalid'> = {};
  const words: string[] = [];

  for (const parameter of command.parameters) {
    const draft = drafts[parameter.key];
    if (typeof draft === 'boolean') {
      if (!draft && parameter.optional) continue;
      args[parameter.key] = draft;
      if (parameter.flag) words.push(parameter.flag);
      else words.push(parameter.optional ? `--${flagName(parameter.key)}` : String(draft));
      continue;
    }
    const item = itemSchemaOf(parameter.schema);
    if (parameter.schema.schema_type === 'array') {
      const entries = (Array.isArray(draft) ? draft : []).filter((entry) => entry.trim() !== '');
      const values = entries.map((entry) => coerceItem(item, entry));
      if (values.some((value) => value === null)) {
        errors[parameter.key] = 'invalid';
        continue;
      }
      if (values.length === 0) {
        if (!parameter.optional) errors[parameter.key] = 'required';
        continue;
      }
      args[parameter.key] = values as LiteralValue[];
      words.push(...(values as LiteralValue[]).map((value) => named(parameter, bodyWord(value))));
      continue;
    }
    const input = typeof draft === 'string' ? draft : '';
    if (input.trim() === '') {
      if (!parameter.optional) errors[parameter.key] = 'required';
      continue;
    }
    const value = coerceItem(item, input);
    if (value === null) {
      errors[parameter.key] = 'invalid';
      continue;
    }
    args[parameter.key] = value;
    words.push(
      named(parameter, parameter.key === command.tailParameter ? input.trim() : bodyWord(value))
    );
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    invocation: { command: command.command, arguments: args },
    body: [`${prefix}${command.command}`, ...words].join(' '),
  };
}
