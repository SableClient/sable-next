import type {
  ArgumentDraft,
  BotCommand,
  ItemSchema,
  LiteralValue,
  ParameterSchema,
  PrimitiveType,
} from '#src/generated/protocol';

import { issueEnvironment } from '#lib/features/bug-report/forge.js';
import type { ArgumentDrafts } from '#lib/model/model.js';
import { describePlatform, issuePlatform } from '#lib/platform/diagnostics.js';

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

function isEmptyDraft(draft: ArgumentDraft | undefined): boolean {
  return draft === undefined || draft === '' || (Array.isArray(draft) && draft.length === 0);
}

export async function prefillDrafts(
  command: BotCommand,
  drafts: ArgumentDrafts,
  homeserver: string
): Promise<void> {
  const wanted = command.parameters.filter(
    (parameter) => typeof parameter.prefill === 'string' && isEmptyDraft(drafts[parameter.key])
  );
  if (wanted.length === 0) return;
  const [platform, option] = await Promise.all([describePlatform(), issuePlatform()]);
  for (const parameter of wanted) {
    if (!isEmptyDraft(drafts[parameter.key])) continue;
    if (parameter.prefill === 'environment') {
      drafts[parameter.key] = issueEnvironment(platform, '', homeserver);
    } else if (
      parameter.prefill === 'platform' &&
      literalChoices(itemSchemaOf(parameter.schema))?.some((choice) => choice === option)
    ) {
      drafts[parameter.key] = parameter.schema.schema_type === 'array' ? [option] : option;
    }
  }
}

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
