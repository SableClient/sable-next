import * as v from 'valibot';

export type E2eePolicy = { defaultEncrypted: boolean; forceDisabled: boolean };

export const defaultE2eePolicy: E2eePolicy = { defaultEncrypted: true, forceDisabled: false };

const Section = v.optional(
  v.object({ default: v.optional(v.boolean()), force_disable: v.optional(v.boolean()) })
);

const WellKnownSchema = v.pipe(
  v.object({ 'io.element.e2ee': Section, 'im.vector.riot.e2ee': Section }),
  v.transform((wellKnown): E2eePolicy => {
    const section = wellKnown['io.element.e2ee'] ?? wellKnown['im.vector.riot.e2ee'];
    return {
      defaultEncrypted: section?.default ?? true,
      forceDisabled: section?.force_disable ?? false,
    };
  })
);

export function parseE2eePolicy(wellKnown: unknown): E2eePolicy {
  const result = v.safeParse(WellKnownSchema, wellKnown);
  return result.success ? result.output : defaultE2eePolicy;
}
