import type {
  BotCommand,
  ItemSchema,
  LiteralValue,
  ParameterSchema,
  PrimitiveType,
} from '#src/generated/protocol';

export type {
  ArgumentDraft,
  BotCommand,
  BotCommandInvocation,
  BotCommandParameter,
  InvocationResult,
  ItemSchema,
  LiteralValue,
  ParameterSchema,
  PrimitiveType,
} from '#src/generated/protocol';
export {
  buildInvocation,
  draftsFromText,
  literalLabel,
  matchBotCommand,
  parseBotCommand,
  type ArgumentDrafts,
} from '#lib/model/model.js';

export function botCommandId(command: BotCommand): string {
  return `bot:${command.sender} ${command.command}`;
}

export function botCommandNames(command: BotCommand): string[] {
  return [command.command, ...command.aliases];
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
  const choices: LiteralValue[] = [];
  for (const variant of schema.variants) {
    if (variant.schema_type !== 'literal') return null;
    choices.push(variant.value);
  }
  return choices;
}

export function acceptsType(schema: ParameterSchema, type: PrimitiveType): boolean {
  const item = itemSchemaOf(schema);
  if (item.schema_type === 'primitive') return item.type === type;
  if (item.schema_type !== 'union') return false;
  return item.variants.some(
    (variant) => variant.schema_type === 'primitive' && variant.type === type
  );
}
