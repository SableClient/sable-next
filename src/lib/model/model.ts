import type {
  ArgumentDraft,
  BotCommand,
  BotCommandDescription,
  BotCommandMatch,
  CalendarEntryView,
  CalendarItem,
  CalendarRsvpView,
  InvocationResult,
  EventDraft,
  EventPreview,
  HierarchyRoomView,
  HierarchySection,
  JoinAddress,
  JoinCandidate,
  LobbyAction,
  LiteralValue,
  MatrixLink,
  MfmColor,
  MfmUnixtime,
  NotificationModeView,
  ParsedQuery,
  PushAlert,
  PushContent,
  PackImageDraftView,
  PermissionGroup,
  PowerLevelLocation,
  PushNotification,
  ResolvedQuery,
  RoomPowerLevelsView,
  SearchDirectory,
  SearchPerson,
  SearchRoom,
  RoomJoinRuleView,
  RsvpTally,
  SidebarItemView,
  PronounView,
  SearchOperator,
  SlashParse,
  SpaceChildEdge,
  TargetSuggestion,
  ViaSplit,
  WebPushValidation,
  ZonedInstant,
} from '#src/generated/protocol';
import loadWasm, * as wasm from '#src/generated/wasm/sable_model.js';

export type ArgumentDrafts = Record<string, ArgumentDraft>;

let loading: Promise<unknown> | null = null;

/** Every call below needs this to have settled once; a failed load is retried. */
export function loadModel(): Promise<unknown> {
  loading ??= loadWasm().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

export function parseSearchQuery(input: string): ParsedQuery {
  return JSON.parse(wasm.parseSearchQuery(input)) as ParsedQuery;
}

export function searchOperators(): SearchOperator[] {
  return JSON.parse(wasm.searchOperators()) as SearchOperator[];
}

export function parseMatrixLink(href: string): MatrixLink | null {
  return JSON.parse(wasm.parseMatrixLink(href)) as MatrixLink | null;
}

export function parseJoinAddress(input: string): JoinAddress | null {
  return JSON.parse(wasm.parseJoinAddress(input)) as JoinAddress | null;
}

export function splitVia(href: string): ViaSplit {
  return JSON.parse(wasm.splitVia(href)) as ViaSplit;
}

export function parseBotCommand(view: BotCommandDescription): BotCommand | null {
  return JSON.parse(wasm.parseBotCommand(JSON.stringify(view))) as BotCommand | null;
}

export function parseBotCommands(views: readonly BotCommandDescription[]): BotCommand[] {
  return JSON.parse(wasm.parseBotCommands(JSON.stringify(views))) as BotCommand[];
}

export function matchBotCommand(
  line: string,
  commands: readonly BotCommand[]
): BotCommandMatch | null {
  return JSON.parse(wasm.matchBotCommand(line, JSON.stringify(commands))) as BotCommandMatch | null;
}

export function emptyDrafts(command: BotCommand): ArgumentDrafts {
  return JSON.parse(wasm.emptyDrafts(JSON.stringify(command))) as ArgumentDrafts;
}

export function draftsFromText(command: BotCommand, args: string): ArgumentDrafts {
  return JSON.parse(wasm.draftsFromText(JSON.stringify(command), args)) as ArgumentDrafts;
}

export function buildInvocation(
  command: BotCommand,
  drafts: ArgumentDrafts,
  prefix = '/'
): InvocationResult {
  return JSON.parse(
    wasm.buildInvocation(JSON.stringify(command), JSON.stringify(drafts), prefix)
  ) as InvocationResult;
}

export function literalLabel(value: LiteralValue): string {
  return wasm.literalLabel(JSON.stringify(value));
}

export function parsePushPayload(raw: string | undefined): PushNotification | null {
  if (raw === undefined) return null;
  return JSON.parse(wasm.parsePushPayload(raw)) as PushNotification | null;
}

export function webPushValidation(raw: string | undefined): WebPushValidation | null {
  if (raw === undefined) return null;
  return JSON.parse(wasm.webPushValidation(raw)) as WebPushValidation | null;
}

export function pushContent(content: unknown): PushContent {
  return JSON.parse(wasm.pushContent(JSON.stringify(content ?? null))) as PushContent;
}

export function roomTag(userId: string | null | undefined, roomId: string): string {
  return wasm.roomTag(userId ?? '', roomId);
}

export function silencedByRoomMode(
  notification: PushNotification,
  mode: NotificationModeView | null
): boolean {
  return wasm.silencedByRoomMode(JSON.stringify(notification), JSON.stringify(mode));
}

export function pushAlert(
  notification: PushNotification,
  roomName: string | null,
  showContent: boolean
): PushAlert | null {
  return JSON.parse(
    wasm.pushAlert(JSON.stringify(notification), roomName ?? undefined, showContent)
  ) as PushAlert | null;
}

export function slashCommandNames(): string[] {
  return JSON.parse(wasm.slashCommandNames()) as string[];
}

export function parseSlash(
  body: string,
  formatted: string | null = null,
  now = Date.now()
): SlashParse {
  return JSON.parse(wasm.parseSlash(body, formatted ?? undefined, now)) as SlashParse;
}

export function pronounSets(text: string): PronounView[] {
  return JSON.parse(wasm.pronounSets(text)) as PronounView[];
}

const MFM_SPAN_LIMIT = 2048;

export function normalizeMfmHex(value: string): string | undefined {
  return wasm.normalizeMfmHex(value);
}

export function isOpaqueMatrixColor(value: string): boolean {
  return wasm.isOpaqueMatrixColor(value);
}

/** The serializer probes every offset, so anything that is not `$[` stays on this side. */
export function parseMfmColor(src: string): MfmColor | null {
  if (!src.startsWith('$[')) return null;
  return JSON.parse(wasm.parseMfmColor(src.slice(0, MFM_SPAN_LIMIT))) as MfmColor | null;
}

export function parseMfmUnixtime(src: string): MfmUnixtime | null {
  if (!src.startsWith('$[')) return null;
  return JSON.parse(wasm.parseMfmUnixtime(src.slice(0, MFM_SPAN_LIMIT))) as MfmUnixtime | null;
}

export function canonicalDatetime(value: string): string | null {
  return wasm.canonicalDatetime(value) ?? null;
}

export function parseZonedDatetime(value: string): ZonedInstant | null {
  return JSON.parse(wasm.parseZonedDatetime(value)) as ZonedInstant | null;
}

export function unixSecondsOf(datetime: string): string | null {
  return wasm.unixSecondsOf(datetime) ?? null;
}

export function readCalendarEntries(entries: readonly CalendarEntryView[]): CalendarItem[] {
  return JSON.parse(wasm.readCalendarEntries(JSON.stringify(entries))) as CalendarItem[];
}

export function calendarWallTimes(item: CalendarItem, before: string): string[] {
  return JSON.parse(wasm.calendarWallTimes(JSON.stringify(item), before)) as string[];
}

export function tallyRsvps(
  rsvps: readonly CalendarRsvpView[],
  uid: string,
  recurrenceId: string | null,
  userId: string | null
): RsvpTally {
  return JSON.parse(
    wasm.tallyRsvps(JSON.stringify(rsvps), uid, recurrenceId ?? undefined, userId ?? undefined)
  ) as RsvpTally;
}

export function buildCalendarEvent(
  draft: EventDraft,
  base: Record<string, unknown> | null,
  uid: string,
  now: number,
  timeZone: string
): Record<string, unknown> {
  return JSON.parse(
    wasm.buildCalendarEvent(JSON.stringify(draft), JSON.stringify(base), uid, now, timeZone)
  ) as Record<string, unknown>;
}

export function parseDuration(value: unknown): number {
  return typeof value === 'string' ? wasm.parseDuration(value) : 0;
}

export function formatDuration(ms: number): string {
  return wasm.formatDuration(ms);
}

export function lobbyAction(
  joinRule: RoomJoinRuleView,
  invited: boolean,
  inParent = true
): LobbyAction | null {
  return JSON.parse(
    wasm.lobbyAction(JSON.stringify(joinRule), invited, inParent)
  ) as LobbyAction | null;
}

export function mergeHierarchyRooms(
  local: readonly HierarchyRoomView[],
  fetched: readonly HierarchyRoomView[]
): HierarchyRoomView[] {
  return JSON.parse(
    wasm.mergeHierarchyRooms(JSON.stringify(local), JSON.stringify(fetched))
  ) as HierarchyRoomView[];
}

/** Every level counts as loaded unless `loaded` says otherwise. */
export type SectionInputs = {
  loaded?: Iterable<string>;
  failed?: Iterable<string>;
  keepEmpty?: Iterable<string>;
  joined?: Iterable<string>;
  invited?: Iterable<string>;
};

export function buildHierarchySections(
  rooms: readonly HierarchyRoomView[],
  rootId: string,
  inputs: SectionInputs = {}
): HierarchySection[] {
  const sets = {
    loaded: inputs.loaded === undefined ? null : [...inputs.loaded],
    failed: [...(inputs.failed ?? [])],
    keep_empty: [...(inputs.keepEmpty ?? [])],
    joined: [...(inputs.joined ?? [])],
    invited: [...(inputs.invited ?? [])],
  };
  return JSON.parse(
    wasm.buildHierarchySections(JSON.stringify(rooms), rootId, JSON.stringify(sets))
  ) as HierarchySection[];
}

export function joinCandidates(
  sections: readonly HierarchySection[],
  joined: Iterable<string>
): JoinCandidate[] {
  return JSON.parse(wasm.joinCandidates(JSON.stringify(sections), [...joined])) as JoinCandidate[];
}

export function applyChildOverrides(
  rooms: readonly HierarchyRoomView[],
  overrides: readonly { parent_id: string; children: readonly SpaceChildEdge[] }[]
): HierarchyRoomView[] {
  return JSON.parse(
    wasm.applyChildOverrides(JSON.stringify(rooms), JSON.stringify(overrides))
  ) as HierarchyRoomView[];
}

export function applySuggestedOverrides(
  rooms: readonly HierarchyRoomView[],
  overrides: readonly { parent_id: string; room_id: string; suggested: boolean }[]
): HierarchyRoomView[] {
  return JSON.parse(
    wasm.applySuggestedOverrides(JSON.stringify(rooms), JSON.stringify(overrides))
  ) as HierarchyRoomView[];
}

export type LayoutTarget =
  | { kind: 'space'; room_id: string; folder_id: string | null }
  | { kind: 'folder'; folder_id: string };

function items(value: string): SidebarItemView[] {
  return JSON.parse(value) as SidebarItemView[];
}

function ids(value: string): string[] {
  return JSON.parse(value) as string[];
}

export function layoutSpaceIds(layout: readonly SidebarItemView[]): string[] {
  return ids(wasm.layoutSpaceIds(JSON.stringify(layout)));
}

export function mergeSpaces(
  layout: readonly SidebarItemView[],
  spaceIds: readonly string[]
): SidebarItemView[] {
  return items(wasm.mergeSpaces(JSON.stringify(layout), JSON.stringify(spaceIds)));
}

export function withSpace(layout: readonly SidebarItemView[], roomId: string): SidebarItemView[] {
  return items(wasm.withSpace(JSON.stringify(layout), roomId));
}

export function withoutSpace(
  layout: readonly SidebarItemView[],
  roomId: string
): SidebarItemView[] {
  return items(wasm.withoutSpace(JSON.stringify(layout), roomId));
}

export function rememberSpaceIds(known: readonly string[], current: readonly string[]): string[] {
  return ids(wasm.rememberSpaceIds(JSON.stringify(known), JSON.stringify(current)));
}

export function orderedKnownSpaceIds(
  known: readonly string[],
  current: readonly string[]
): string[] {
  return ids(wasm.orderedKnownSpaceIds(JSON.stringify(known), JSON.stringify(current)));
}

export function renameFolder(
  layout: readonly SidebarItemView[],
  folderId: string,
  name: string
): SidebarItemView[] {
  return items(wasm.renameFolder(JSON.stringify(layout), folderId, name));
}

export function ungroupFolder(
  layout: readonly SidebarItemView[],
  folderId: string
): SidebarItemView[] {
  return items(wasm.ungroupFolder(JSON.stringify(layout), folderId));
}

export function removeFromFolder(
  layout: readonly SidebarItemView[],
  roomId: string,
  folderId: string
): SidebarItemView[] {
  return items(wasm.removeFromFolder(JSON.stringify(layout), roomId, folderId));
}

export function applyLayoutDrop(
  layout: readonly SidebarItemView[],
  source: LayoutTarget,
  target: LayoutTarget,
  instruction: 'above' | 'below' | 'into',
  newFolderId: string
): SidebarItemView[] {
  return items(
    wasm.applyDrop(
      JSON.stringify(layout),
      JSON.stringify(source),
      JSON.stringify(target),
      JSON.stringify(instruction),
      newFolderId
    )
  );
}

export function eventPreview(source: unknown): EventPreview | null {
  return JSON.parse(wasm.eventPreview(JSON.stringify(source))) as EventPreview | null;
}

export function permissionGroups(isSpace: boolean): PermissionGroup[] {
  return JSON.parse(wasm.permissionGroups(isSpace)) as PermissionGroup[];
}

export function levelAt(levels: RoomPowerLevelsView, location: PowerLevelLocation): number {
  return JSON.parse(wasm.levelAt(JSON.stringify(levels), JSON.stringify(location))) as number;
}

export function canSendState(
  levels: RoomPowerLevelsView | null,
  ownPowerLevel: number,
  eventType: string
): boolean {
  return levels !== null && wasm.canSendState(JSON.stringify(levels), ownPowerLevel, eventType);
}

const encoded = new WeakMap<object, string>();

/** A directory is rebuilt only when the room list changes, so its JSON is kept. */
function encode(value: object): string {
  let json = encoded.get(value);
  if (json === undefined) {
    json = JSON.stringify(value);
    encoded.set(value, json);
  }
  return json;
}

export function resolveSearchQuery(query: string, directory: SearchDirectory): ResolvedQuery {
  return JSON.parse(wasm.resolveSearchQuery(query, encode(directory))) as ResolvedQuery;
}

export function resolveRoomTarget(rooms: readonly SearchRoom[], value: string): string | undefined {
  return wasm.resolveRoomTarget(encode(rooms), value);
}

export function resolveSpaceTarget(
  rooms: readonly SearchRoom[],
  value: string
): string | undefined {
  return wasm.resolveSpaceTarget(encode(rooms), value);
}

export function suggestRoomTarget(
  rooms: readonly SearchRoom[],
  value: string,
  spacesOnly = false
): TargetSuggestion | undefined {
  return (
    (JSON.parse(
      wasm.suggestRoomTarget(encode(rooms), value, spacesOnly)
    ) as TargetSuggestion | null) ?? undefined
  );
}

export function suggestPersonTarget(
  people: readonly SearchPerson[],
  value: string
): TargetSuggestion | undefined {
  return (
    (JSON.parse(wasm.suggestPersonTarget(encode(people), value)) as TargetSuggestion | null) ??
    undefined
  );
}

export function normalizeShortcode(raw: string): string {
  return wasm.normalizeShortcode(raw);
}

export function uniqueShortcode(shortcode: string, taken: Iterable<string>): string {
  return wasm.uniqueShortcode(shortcode, [...taken]);
}

export function invalidShortcode(images: readonly PackImageDraftView[]): string | null {
  return wasm.invalidShortcode(images.map((image) => image.shortcode)) ?? null;
}

export function shortcodeWithoutExtension(fileName: string): string {
  return wasm.shortcodeWithoutExtension(fileName);
}

export function reactionKey(content: unknown): string | null {
  return wasm.reactionKey(JSON.stringify(content ?? null)) ?? null;
}
