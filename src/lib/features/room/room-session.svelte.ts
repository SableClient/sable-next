import { MEMBER_LIST_EVENT_TYPE, readAlwaysListedFrom } from './settings/member-list.svelte.js';
import { readTombstone } from './settings/room-upgrade.js';
import type { CoreCommands } from '#lib/core/commands.svelte.js';
import type {
  PredecessorRoomView,
  RoomPermissionsView,
  RoomPowerLevelsView,
  RoomStateEventView,
} from '#src/generated/protocol';
import { parseRoomWidget, type RoomWidget } from '#lib/features/widgets/widget-content.js';
import { enrichWidgetUrl } from '#lib/features/widgets/widget-url.js';
import { parsePowerLevelTags, type PowerLevelTagMap } from './settings/power-level-tags.js';
import type { PinnedEvents } from './timeline/pinned-events.svelte.js';

type RoomDetailCommands = Pick<
  CoreCommands,
  'roomStateEvent' | 'roomOpen' | 'roomPowerLevels' | 'roomStateEvents' | 'sendStateEvent'
>;

function parseWidgets(events: readonly RoomStateEventView[]): RoomWidget[] {
  return events.flatMap((event) => {
    const widget = parseRoomWidget(event.state_key, event.content);
    return widget ? [widget] : [];
  });
}

export class RoomDetails {
  permissions = $state<RoomPermissionsView | null>(null);
  powerLevels = $state<RoomPowerLevelsView | null>(null);
  powerTags = $state.raw<PowerLevelTagMap | null>(null);
  widgets = $state.raw<RoomWidget[]>([]);
  predecessor = $state.raw<PredecessorRoomView | null>(null);
  #generation = 0;
  #roomId = '';

  constructor(
    private readonly commands: RoomDetailCommands,
    private readonly pins: Pick<PinnedEvents, 'set'>
  ) {}

  start(roomId: string): () => void {
    const generation = ++this.#generation;
    this.#roomId = roomId;
    this.permissions = null;
    this.powerLevels = null;
    this.powerTags = null;
    this.widgets = [];
    this.predecessor = null;
    void this.commands
      .roomOpen(roomId)
      .then((opened) => {
        if (generation !== this.#generation) return;
        this.permissions = opened.permissions;
        this.predecessor = opened.predecessor;
        this.powerTags = parsePowerLevelTags(opened.power_level_tags);
        this.widgets = parseWidgets(opened.widgets);
        this.pins.set(roomId, opened.pinned_event_ids);
      })
      .catch((error: unknown) => {
        console.debug('[sable room] room details unavailable', error);
        if (generation === this.#generation) this.powerTags = {};
      });
    void this.commands
      .roomPowerLevels(roomId)
      .then((levels) => {
        if (generation === this.#generation) this.powerLevels = levels;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] power levels unavailable', error);
      });
    return () => {
      if (generation === this.#generation) this.#generation += 1;
    };
  }

  async addWidget(name: string, url: string, userId: string): Promise<void> {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    await this.commands.sendStateEvent(this.#roomId, 'im.vector.modular.widgets', id, {
      type: 'm.custom',
      url: enrichWidgetUrl(url),
      name,
      id,
      creatorUserId: userId,
    });
    await this.refreshWidgets();
  }

  async removeWidget(widgetId: string): Promise<void> {
    await this.commands.sendStateEvent(this.#roomId, 'im.vector.modular.widgets', widgetId, {});
    await this.refreshWidgets();
  }

  async refreshWidgets(): Promise<void> {
    const generation = this.#generation;
    const widgets = await this.commands.roomStateEvents(this.#roomId, 'im.vector.modular.widgets');
    if (generation === this.#generation) this.widgets = parseWidgets(widgets);
  }
}

export class RoomMemberList {
  alwaysListedFrom = $state<number | null>(null);
  #roomId: string | null = null;

  constructor(private readonly commands: Pick<RoomDetailCommands, 'roomStateEvent'>) {}

  start(roomId: string): () => void {
    if (roomId !== this.#roomId) this.alwaysListedFrom = null;
    this.#roomId = roomId;
    let current = true;
    void this.commands
      .roomStateEvent(roomId, MEMBER_LIST_EVENT_TYPE)
      .then((content) => {
        if (current) this.alwaysListedFrom = readAlwaysListedFrom(content);
      })
      .catch((error: unknown) => {
        console.debug('[sable room] member list settings unavailable', error);
        if (current) this.alwaysListedFrom = null;
      });
    return () => {
      current = false;
    };
  }
}

export class RoomTombstone {
  replacementId = $state<string | null>(null);
  body = $state<string | null>(null);
  checked = $state(false);

  constructor(private readonly commands: Pick<RoomDetailCommands, 'roomStateEvent'>) {}

  start(roomId: string, tombstoned: boolean): () => void {
    this.replacementId = null;
    this.body = null;
    this.checked = false;
    if (!tombstoned) return () => {};

    let current = true;
    void this.commands
      .roomStateEvent(roomId, 'm.room.tombstone')
      .then((content) => {
        if (!current) return;
        const grave = readTombstone(content);
        this.replacementId = grave.replacement;
        this.body = grave.body;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] tombstone unavailable', error);
      })
      .finally(() => {
        if (current) this.checked = true;
      });
    return () => {
      current = false;
    };
  }
}

export class RoomSession {
  readonly details: RoomDetails;
  readonly memberList: RoomMemberList;
  readonly tombstone: RoomTombstone;
  #roomId: string | null = null;
  #memberListRevision: number | null = null;
  #tombstoned: boolean | null = null;
  #stopDetails: (() => void) | null = null;
  #stopMemberList: (() => void) | null = null;
  #stopTombstone: (() => void) | null = null;

  constructor(commands: RoomDetailCommands, pins: Pick<PinnedEvents, 'set'>) {
    this.details = new RoomDetails(commands, pins);
    this.memberList = new RoomMemberList(commands);
    this.tombstone = new RoomTombstone(commands);
  }

  get permissions(): RoomPermissionsView | null {
    return this.details.permissions;
  }

  get powerLevels(): RoomPowerLevelsView | null {
    return this.details.powerLevels;
  }

  get powerTags(): PowerLevelTagMap | null {
    return this.details.powerTags;
  }

  get widgets(): readonly RoomWidget[] {
    return this.details.widgets;
  }

  get predecessor(): PredecessorRoomView | null {
    return this.details.predecessor;
  }

  get alwaysListedFrom(): number | null {
    return this.memberList.alwaysListedFrom;
  }

  get tombstoneReplacementId(): string | null {
    return this.tombstone.replacementId;
  }

  get tombstoneBody(): string | null {
    return this.tombstone.body;
  }

  get tombstoneChecked(): boolean {
    return this.tombstone.checked;
  }

  sync(roomId: string, tombstoned: boolean, memberListRevision: number): void {
    if (roomId !== this.#roomId) {
      this.dispose();
      this.#roomId = roomId;
      this.#stopDetails = this.details.start(roomId);
      this.#memberListRevision = null;
      this.#tombstoned = null;
    }
    if (memberListRevision !== this.#memberListRevision) {
      this.#stopMemberList?.();
      this.#stopMemberList = this.memberList.start(roomId);
      this.#memberListRevision = memberListRevision;
    }
    if (tombstoned !== this.#tombstoned) {
      this.#stopTombstone?.();
      this.#stopTombstone = this.tombstone.start(roomId, tombstoned);
      this.#tombstoned = tombstoned;
    }
  }

  dispose(): void {
    this.#stopDetails?.();
    this.#stopMemberList?.();
    this.#stopTombstone?.();
    this.#stopDetails = null;
    this.#stopMemberList = null;
    this.#stopTombstone = null;
    this.#roomId = null;
    this.#memberListRevision = null;
    this.#tombstoned = null;
  }
}
