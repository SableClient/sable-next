interface Migration {
  version: number;
  run: (stored: Record<string, unknown>) => Record<string, unknown>;
}

const LEGACY_FONT_SCALES: Record<string, number | undefined> = {
  smallest: 0.75,
  small: 0.9375,
  large: 1.125,
  largest: 1.25,
  huge: 1.5,
};

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    run(stored) {
      if (stored.pageZoom !== undefined || typeof stored.fontScale !== 'string') return stored;
      const pageZoom = LEGACY_FONT_SCALES[stored.fontScale];
      return pageZoom === undefined ? stored : { ...stored, pageZoom };
    },
  },
  {
    version: 2,
    run(stored) {
      return stored.desktopNotifications === false
        ? { ...stored, systemNotifications: false }
        : stored;
    },
  },
  {
    version: 3,
    run(stored) {
      if (stored.personaLatching === undefined) return stored;
      const { personaLatching, ...rest } = stored;
      return { ...rest, personaKeepAfterShorthand: personaLatching !== 'off' };
    },
  },
  {
    version: 4,
    run(stored) {
      if (stored.hardwareVideoAcceleration === undefined) return stored;
      const { hardwareVideoAcceleration, ...rest } = stored;
      return {
        ...rest,
        hardwareVideoEncode: hardwareVideoAcceleration,
        hardwareVideoDecode: hardwareVideoAcceleration,
      };
    },
  },
];

export const SETTINGS_SCHEMA = Math.max(...MIGRATIONS.map((migration) => migration.version));

export function migrateSettings(
  stored: Record<string, unknown>,
  from: unknown
): Record<string, unknown> {
  const start = typeof from === 'number' && Number.isInteger(from) && from > 0 ? from : 0;
  let next = stored;
  for (const migration of MIGRATIONS) {
    if (migration.version > start) next = migration.run(next);
  }
  return next;
}
