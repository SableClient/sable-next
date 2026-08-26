import type { BookmarkView } from '#src/generated/BookmarkView';
import type { PerMessageProfileView } from '#src/generated/PerMessageProfileView';
import type { PersonaCatalogView } from '#src/generated/PersonaCatalogView';
import type { PersonaView } from '#src/generated/PersonaView';
import type { DeviceView } from '#src/generated/DeviceView';
import type { EncryptionStatusView } from '#src/generated/EncryptionStatusView';
import type { ImagePackView } from '#src/generated/ImagePackView';
import type { JoinRuleView } from '#src/generated/JoinRuleView';
import type { MemberView } from '#src/generated/MemberView';
import type { MembershipView } from '#src/generated/MembershipView';
import type { NotificationModeView } from '#src/generated/NotificationModeView';
import type { NotificationSettingsView } from '#src/generated/NotificationSettingsView';
import type { PusherView } from '#src/generated/PusherView';
import type { RoomTag } from '#src/generated/RoomTag';
import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
import type { CallSupportView } from '#src/generated/CallSupportView';
import type { RoomPowerLevelsView } from '#src/generated/RoomPowerLevelsView';
import type { RoomVersionsView } from '#src/generated/RoomVersionsView';
import type { SearchFilter } from '#src/generated/SearchFilter';
import type { SearchHitView } from '#src/generated/SearchHitView';
import type { SearchOrder } from '#src/generated/SearchOrder';
import type { RoomPreviewView } from '#src/generated/RoomPreviewView';
import type { RoomSummary } from '#src/generated/RoomSummary';
import type { SidebarItemView } from '#src/generated/SidebarItemView';
import type { SpaceHierarchyRoomView } from '#src/generated/SpaceHierarchyRoomView';
import type { SubscriptionId } from '#src/generated/SubscriptionId';
import type { PaginationDirection } from '#src/generated/PaginationDirection';
import type { CreateRoomKind } from '#src/generated/CreateRoomKind';
import type { TimelineItemView } from '#src/generated/TimelineItemView';
import type { RegistrationResultView } from '#src/generated/RegistrationResultView';
import { maxAttachmentBytes } from './limits';
import type { Transport } from '../../transport';

export type CallGrant = {
  session: number;
  url: string;
  jwt: string;
  identity: string;
  encryptMedia: boolean;
};

export type CreateRoomOptions = {
  name?: string | null;
  topic?: string | null;
  kind?: CreateRoomKind;
  public?: boolean;
  encrypted?: boolean;
  invite?: string[];
  parentSpace?: string | null;
};

export interface OutgoingMentions {
  userIds: string[];
  room: boolean;
}

const noMentions: OutgoingMentions = { userIds: [], room: false };

const EMPTY_SEARCH_FILTER: SearchFilter = {
  rooms: [],
  senders: [],
  mentions: [],
  has: [],
  not_rooms: [],
  not_senders: [],
  not_mentions: [],
  not_has: [],
  after_ts: null,
  before_ts: null,
  phrases: [],
  exclude: [],
};

export function createCommands(transport: () => Transport) {
  return {
    async requestRegistrationEmail(email: string): Promise<RegistrationResultView> {
      const response = await transport().send({
        type: 'request_registration_email',
        email,
      });
      return response.result;
    },

    async submitRegistrationEmail(token: string): Promise<RegistrationResultView> {
      const response = await transport().send({
        type: 'submit_registration_email',
        token,
      });
      return response.result;
    },

    async cancelRegistration(): Promise<void> {
      await transport().send({ type: 'cancel_registration' });
    },

    async subscribeRoomList(): Promise<{
      subscription: SubscriptionId;
      rooms: RoomSummary[];
    }> {
      const response = await transport().send({
        type: 'subscribe_room_list',
      });
      return response;
    },

    async subscribeTimeline(
      roomId: string,
      eventId: string | null = null,
      hiddenEvents = false
    ): Promise<{ subscription: SubscriptionId; items: TimelineItemView[] }> {
      const response = await transport().send({
        type: 'subscribe_timeline',
        room_id: roomId,
        event_id: eventId,
        hidden_events: hiddenEvents,
      });
      return response;
    },

    async paginate(
      subscription: SubscriptionId,
      direction: PaginationDirection,
      count: number
    ): Promise<{ reached_end: boolean }> {
      const response = await transport().send({
        type: 'paginate',
        subscription,
        direction,
        count,
      });
      return { reached_end: response.reached_end };
    },

    async roomMembers(
      roomId: string,
      memberships: readonly MembershipView[] = []
    ): Promise<MemberView[]> {
      const response = await transport().send({
        type: 'room_members',
        room_id: roomId,
        memberships: [...memberships],
      });
      return response.members;
    },

    async callSupport(roomId: string): Promise<CallSupportView> {
      const response = await transport().send({ type: 'call_support', room_id: roomId });
      return response;
    },

    async roomAliases(roomId: string): Promise<string[]> {
      const response = await transport().send({ type: 'room_aliases', room_id: roomId });
      return response.aliases;
    },

    async createRoomAlias(roomId: string, alias: string): Promise<void> {
      await transport().send({ type: 'create_room_alias', room_id: roomId, alias });
    },

    async deleteRoomAlias(alias: string): Promise<void> {
      await transport().send({ type: 'delete_room_alias', alias });
    },

    async roomDirectoryVisibility(roomId: string): Promise<boolean> {
      const response = await transport().send({
        type: 'room_directory_visibility',
        room_id: roomId,
      });
      return response.public;
    },

    async setRoomDirectoryVisibility(roomId: string, isPublic: boolean): Promise<void> {
      await transport().send({
        type: 'set_room_directory_visibility',
        room_id: roomId,
        public: isPublic,
      });
    },

    async roomVersions(): Promise<RoomVersionsView> {
      const response = await transport().send({
        type: 'room_versions',
      });
      return response;
    },

    async upgradeRoom(
      roomId: string,
      newVersion: string,
      additionalCreators: readonly string[] = []
    ): Promise<string> {
      const response = await transport().send({
        type: 'upgrade_room',
        room_id: roomId,
        new_version: newVersion,
        additional_creators: [...additionalCreators],
      });
      return response.replacement_room;
    },

    async roomStateEvent(roomId: string, eventType: string, stateKey = ''): Promise<unknown> {
      const response = await transport().send({
        type: 'room_state_event',
        room_id: roomId,
        event_type: eventType,
        state_key: stateKey,
      });
      return response.content;
    },

    async roomPermissions(roomId: string): Promise<RoomPermissionsView> {
      const response = await transport().send({
        type: 'room_permissions',
        room_id: roomId,
      });
      return response;
    },

    async roomPowerLevels(roomId: string): Promise<RoomPowerLevelsView> {
      const response = await transport().send({
        type: 'room_power_levels',
        room_id: roomId,
      });
      return response;
    },

    async timestampToEvent(
      roomId: string,
      ts: number,
      direction: PaginationDirection = 'backward'
    ): Promise<string | null> {
      const response = await transport().send({
        type: 'timestamp_to_event',
        room_id: roomId,
        ts,
        direction,
      });
      return response.event_id;
    },

    async roomAccountData(roomId: string, eventType: string): Promise<unknown> {
      const response = await transport().send({
        type: 'room_account_data',
        room_id: roomId,
        event_type: eventType,
      });
      return response.content;
    },

    async setRoomAccountData(roomId: string, eventType: string, content: unknown): Promise<void> {
      await transport().send({
        type: 'set_room_account_data',
        room_id: roomId,
        event_type: eventType,
        content,
      });
    },

    async searchMessages(
      query: string,
      options: {
        filter?: SearchFilter;
        order?: SearchOrder;
        limit?: number;
        offset?: number;
      } = {}
    ): Promise<SearchHitView[]> {
      const response = await transport().send({
        type: 'search_messages',
        query,
        filter: options.filter ?? EMPTY_SEARCH_FILTER,
        order: options.order ?? 'rank',
        limit: options.limit ?? 30,
        offset: options.offset ?? 0,
      });
      return response.hits;
    },

    async joinCall(roomId: string, livekitServiceUrl: string | null = null): Promise<CallGrant> {
      const response = await transport().send({
        type: 'join_call',
        room_id: roomId,
        livekit_service_url: livekitServiceUrl,
      });
      return {
        session: response.session,
        url: response.url,
        jwt: response.jwt,
        identity: response.identity,
        encryptMedia: response.encrypt_media,
      };
    },

    async leaveCall(session: number): Promise<void> {
      await transport().send({ type: 'leave_call', session });
    },

    async declineCall(roomId: string, notificationEventId: string): Promise<void> {
      await transport().send({
        type: 'decline_call',
        room_id: roomId,
        notification_event_id: notificationEventId,
      });
    },

    async imagePacks(roomId: string): Promise<ImagePackView[]> {
      const response = await transport().send({
        type: 'image_packs',
        room_id: roomId,
      });
      return response.packs;
    },

    async inviteUser(roomId: string, userId: string): Promise<void> {
      await transport().send({
        type: 'invite_user',
        room_id: roomId,
        user_id: userId,
      });
    },

    async kickUser(roomId: string, userId: string): Promise<void> {
      await transport().send({
        type: 'kick_user',
        room_id: roomId,
        user_id: userId,
        reason: null,
      });
    },

    async banUser(roomId: string, userId: string): Promise<void> {
      await transport().send({
        type: 'ban_user',
        room_id: roomId,
        user_id: userId,
        reason: null,
      });
    },

    async unbanUser(roomId: string, userId: string): Promise<void> {
      await transport().send({
        type: 'unban_user',
        room_id: roomId,
        user_id: userId,
        reason: null,
      });
    },

    async createRoom(options: CreateRoomOptions): Promise<string> {
      const response = await transport().send({
        type: 'create_room',
        name: options.name ?? null,
        topic: options.topic ?? null,
        kind: options.kind ?? 'text',
        public: options.public ?? false,
        encrypted: options.encrypted ?? true,
        invite: options.invite ?? [],
        parent_space: options.parentSpace ?? null,
      });
      return response.room_id;
    },

    async createDm(userId: string): Promise<string> {
      const response = await transport().send({
        type: 'create_dm',
        user_id: userId,
      });
      return response.room_id;
    },

    async roomPreview(address: string, via: string[] = []): Promise<RoomPreviewView> {
      const response = await transport().send({
        type: 'room_preview',
        address,
        via,
      });
      return response.preview;
    },

    async joinRoom(address: string, via: string[] = []): Promise<string> {
      const response = await transport().send({
        type: 'join_room',
        address,
        via,
      });
      return response.room_id;
    },

    async knockRoom(address: string, via: string[] = [], reason?: string): Promise<string> {
      const response = await transport().send({
        type: 'knock_room',
        address,
        via,
        reason: reason ?? null,
      });
      return response.room_id;
    },

    async roomViaServers(roomId: string): Promise<string[]> {
      const response = await transport().send({
        type: 'room_via_servers',
        room_id: roomId,
      });
      return response.servers;
    },

    async leaveRoom(roomId: string): Promise<void> {
      await transport().send({ type: 'leave_room', room_id: roomId });
    },

    async addToSpace(spaceId: string, roomId: string): Promise<void> {
      await transport().send({
        type: 'add_to_space',
        space_id: spaceId,
        room_id: roomId,
      });
    },

    async spaceHierarchy(
      spaceId: string,
      from: string | null = null
    ): Promise<{ rooms: SpaceHierarchyRoomView[]; nextBatch: string | null }> {
      const response = await transport().send({
        type: 'space_hierarchy',
        space_id: spaceId,
        from,
      });
      return { rooms: response.rooms, nextBatch: response.next_batch };
    },

    async removeFromSpace(spaceId: string, roomId: string): Promise<void> {
      await transport().send({
        type: 'remove_from_space',
        space_id: spaceId,
        room_id: roomId,
      });
    },

    async setSpaceChildOrder(spaceId: string, roomId: string, order: string | null): Promise<void> {
      await transport().send({
        type: 'set_space_child_order',
        space_id: spaceId,
        room_id: roomId,
        order,
      });
    },

    async spaceSidebar(): Promise<SidebarItemView[]> {
      const response = await transport().send({
        type: 'space_sidebar',
      });
      return response.items;
    },

    async setSpaceSidebar(items: readonly SidebarItemView[]): Promise<void> {
      await transport().send({
        type: 'set_space_sidebar',
        items: [...items],
      });
    },

    async sendMessage(
      roomId: string,
      body: string,
      inReplyTo: string | null = null,
      formatted: string | null = null,
      mentions: OutgoingMentions = noMentions,
      persona: PerMessageProfileView | null = null
    ): Promise<void> {
      await transport().send({
        type: 'send_message',
        room_id: roomId,
        body,
        formatted,
        in_reply_to: inReplyTo,
        mentions: mentions.userIds,
        mentions_room: mentions.room,
        persona: $state.snapshot(persona),
      });
    },

    async sendSticker(
      roomId: string,
      url: string,
      body: string,
      inReplyTo: string | null = null
    ): Promise<void> {
      await transport().send({
        type: 'send_sticker',
        room_id: roomId,
        url,
        body,
        in_reply_to: inReplyTo,
      });
    },

    async sendGif(
      roomId: string,
      url: string,
      body: string,
      width: number | null,
      height: number | null,
      mimetype: string,
      size: number | null = null,
      inReplyTo: string | null = null
    ): Promise<void> {
      await transport().send({
        type: 'send_gif',
        room_id: roomId,
        url,
        body,
        width,
        height,
        mimetype,
        size,
        in_reply_to: inReplyTo,
      });
    },

    async sendLocation(
      roomId: string,
      body: string,
      geoUri: string,
      inReplyTo: string | null = null
    ): Promise<void> {
      await transport().send({
        type: 'send_location',
        room_id: roomId,
        body,
        geo_uri: geoUri,
        in_reply_to: inReplyTo,
      });
    },

    async editMessage(
      roomId: string,
      eventId: string,
      body: string,
      formatted: string | null = null,
      mentions: OutgoingMentions = noMentions,
      persona: PerMessageProfileView | null = null
    ): Promise<void> {
      await transport().send({
        type: 'edit_message',
        room_id: roomId,
        event_id: eventId,
        body,
        formatted,
        mentions: mentions.userIds,
        mentions_room: mentions.room,
        persona: $state.snapshot(persona),
      });
    },

    async fetchEventDetails(roomId: string, eventId: string): Promise<void> {
      await transport().send({
        type: 'fetch_event_details',
        room_id: roomId,
        event_id: eventId,
      });
    },

    async redact(roomId: string, eventId: string, reason: string | null = null): Promise<void> {
      await transport().send({
        type: 'redact',
        room_id: roomId,
        event_id: eventId,
        reason,
      });
    },

    async pinnedEvents(roomId: string): Promise<string[]> {
      const response = await transport().send({
        type: 'pinned_events',
        room_id: roomId,
      });
      return response.event_ids;
    },

    async setPinned(roomId: string, eventId: string, pinned: boolean): Promise<string[]> {
      const response = await transport().send({
        type: 'set_pinned',
        room_id: roomId,
        event_id: eventId,
        pinned,
      });
      return response.event_ids;
    },

    async reportMessage(
      roomId: string,
      eventId: string,
      reason: string | null = null
    ): Promise<void> {
      await transport().send({
        type: 'report_message',
        room_id: roomId,
        event_id: eventId,
        reason,
      });
    },

    async eventSource(roomId: string, eventId: string): Promise<string> {
      const response = await transport().send({
        type: 'event_source',
        room_id: roomId,
        event_id: eventId,
      });
      return response.source;
    },

    async personas(): Promise<PersonaCatalogView> {
      const response = await transport().send({ type: 'personas' });
      return response.catalog;
    },

    async savePersona(
      persona: PersonaView,
      previousId: string | null = null
    ): Promise<PersonaView[]> {
      const response = await transport().send({
        type: 'save_persona',
        persona,
        previous_id: previousId,
      });
      return response.personas;
    },

    async removePersona(id: string): Promise<PersonaView[]> {
      const response = await transport().send({
        type: 'remove_persona',
        id,
      });
      return response.personas;
    },

    async setPersonaSelection(
      roomId: string | null,
      personaId: string | null,
      validUntil: number | null = null
    ): Promise<void> {
      await transport().send({
        type: 'set_persona_selection',
        room_id: roomId,
        persona_id: personaId,
        valid_until: validUntil,
      });
    },

    async bookmarks(): Promise<BookmarkView[]> {
      const response = await transport().send({ type: 'bookmarks' });
      return response.bookmarks;
    },

    async setBookmark(roomId: string, eventId: string, bookmarked: boolean): Promise<boolean> {
      const response = await transport().send({
        type: 'set_bookmark',
        room_id: roomId,
        event_id: eventId,
        bookmarked,
        now_ms: Date.now(),
      });
      return response.bookmarked;
    },

    async forwardMessage(roomId: string, eventId: string, toRoomId: string): Promise<void> {
      await transport().send({
        type: 'forward_message',
        room_id: roomId,
        event_id: eventId,
        to_room_id: toRoomId,
      });
    },

    async toggleReaction(roomId: string, eventId: string, key: string): Promise<void> {
      await transport().send({
        type: 'react',
        room_id: roomId,
        event_id: eventId,
        key,
      });
    },

    async createPoll(
      roomId: string,
      question: string,
      answers: readonly string[],
      undisclosed = false,
      maxSelections = 1
    ): Promise<void> {
      await transport().send({
        type: 'create_poll',
        room_id: roomId,
        question,
        answers: [...answers],
        undisclosed,
        max_selections: maxSelections,
      });
    },

    async votePoll(roomId: string, eventId: string, answers: readonly string[]): Promise<void> {
      await transport().send({
        type: 'vote_poll',
        room_id: roomId,
        event_id: eventId,
        answers: [...answers],
      });
    },

    async endPoll(roomId: string, eventId: string): Promise<void> {
      await transport().send({
        type: 'end_poll',
        room_id: roomId,
        event_id: eventId,
      });
    },

    async retrySend(roomId: string, transactionId: string): Promise<void> {
      await transport().send({
        type: 'retry_send',
        room_id: roomId,
        transaction_id: transactionId,
      });
    },

    async cancelSend(roomId: string, transactionId: string): Promise<void> {
      await transport().send({
        type: 'cancel_send',
        room_id: roomId,
        transaction_id: transactionId,
      });
    },

    async sendAttachment(
      roomId: string,
      file: File,
      options: { caption?: string | null; inReplyTo?: string | null } = {}
    ): Promise<void> {
      if (file.size > maxAttachmentBytes) throw new Error('Attachment exceeds the 100 MiB limit');
      const bytes = new Uint8Array(await file.arrayBuffer());
      await transport().sendAttachment({
        roomId,
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        bytes,
        caption: options.caption ?? null,
        inReplyTo: options.inReplyTo ?? null,
      });
    },

    fetchMedia(source: string, width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
      return transport().fetchMedia(source, width, height);
    },

    async markRead(roomId: string, eventId: string, privateReceipt = false): Promise<void> {
      await transport().send({
        type: 'mark_read',
        room_id: roomId,
        event_id: eventId,
        private_receipt: privateReceipt,
      });
    },

    async notificationSettings(roomId: string): Promise<NotificationSettingsView> {
      const response = await transport().send({
        type: 'notification_settings',
        room_id: roomId,
      });
      return response;
    },

    async setRoomNotificationMode(
      roomId: string,
      mode: NotificationModeView | null
    ): Promise<void> {
      await transport().send({
        type: 'set_room_notification_mode',
        room_id: roomId,
        mode,
      });
    },

    async defaultNotificationModes(): Promise<{
      direct: NotificationModeView;
      group: NotificationModeView;
    }> {
      const response = await transport().send({
        type: 'default_notification_modes',
      });
      return { direct: response.direct, group: response.group };
    },

    async setDefaultNotificationMode(direct: boolean, mode: NotificationModeView): Promise<void> {
      await transport().send({
        type: 'set_default_notification_mode',
        direct,
        mode,
      });
    },

    async setPusher(pusher: PusherView): Promise<void> {
      await transport().send({ type: 'set_pusher', pusher });
    },

    async removePusher(pushkey: string, appId: string): Promise<void> {
      await transport().send({
        type: 'remove_pusher',
        pushkey,
        app_id: appId,
      });
    },

    async setNotificationContent(visible: boolean): Promise<void> {
      await transport().send({
        type: 'set_notification_content',
        visible,
      });
    },

    async encryptionStatus(): Promise<EncryptionStatusView> {
      const response = await transport().send({
        type: 'encryption_status',
      });
      return response.status;
    },

    async devices(): Promise<{
      devices: DeviceView[];
      accountManagement: boolean;
    }> {
      const response = await transport().send({ type: 'devices' });
      return {
        devices: response.devices,
        accountManagement: response.account_management,
      };
    },

    async recoverIdentity(recoveryKey: string): Promise<void> {
      await transport().send({
        type: 'recover_identity',
        recovery_key: recoveryKey,
      });
    },

    async enableRecovery(): Promise<string> {
      const response = await transport().send({
        type: 'enable_recovery',
        passphrase: null,
      });
      return response.recovery_key;
    },

    async resetRecoveryKey(): Promise<string> {
      const response = await transport().send({
        type: 'reset_recovery_key',
        passphrase: null,
      });
      return response.recovery_key;
    },

    async renameDevice(deviceId: string, displayName: string): Promise<void> {
      await transport().send({
        type: 'rename_device',
        device_id: deviceId,
        display_name: displayName,
      });
    },

    async deleteDevice(deviceId: string, password: string | null): Promise<string | null> {
      const response = await transport().send({
        type: 'delete_device',
        device_id: deviceId,
        password,
      });
      return response.management_url;
    },

    async acceptVerification(userId: string, flowId: string): Promise<void> {
      await transport().send({
        type: 'accept_verification',
        user_id: userId,
        flow_id: flowId,
      });
    },

    async confirmVerification(userId: string, flowId: string): Promise<void> {
      await transport().send({
        type: 'confirm_verification',
        user_id: userId,
        flow_id: flowId,
      });
    },

    async cancelVerification(userId: string, flowId: string, mismatch = false): Promise<void> {
      await transport().send({
        type: 'cancel_verification',
        user_id: userId,
        flow_id: flowId,
        mismatch,
      });
    },

    async setTyping(roomId: string, typing: boolean): Promise<void> {
      await transport().send({
        type: 'set_typing',
        room_id: roomId,
        typing,
      });
    },

    async setDisplayName(name: string | null): Promise<void> {
      await transport().send({ type: 'set_display_name', name });
    },

    async setAvatarUrl(url: string | null): Promise<void> {
      await transport().send({ type: 'set_avatar_url', url });
    },

    async accountContacts(): Promise<string[]> {
      const response = await transport().send({
        type: 'account_contacts',
      });
      return response.emails;
    },

    async ignoredUsers(): Promise<string[]> {
      const response = await transport().send({
        type: 'ignored_users',
      });
      return response.users;
    },

    async setDirect(roomId: string, direct: boolean): Promise<void> {
      await transport().send({
        type: 'set_direct',
        room_id: roomId,
        direct,
      });
    },

    async setRoomTag(roomId: string, tag: RoomTag, set: boolean): Promise<void> {
      await transport().send({
        type: 'set_room_tag',
        room_id: roomId,
        tag,
        set,
      });
    },

    async setRoomName(roomId: string, name: string | null): Promise<void> {
      await transport().send({
        type: 'set_room_name',
        room_id: roomId,
        name,
      });
    },

    async setRoomTopic(roomId: string, topic: string): Promise<void> {
      await transport().send({
        type: 'set_room_topic',
        room_id: roomId,
        topic,
      });
    },

    async setRoomAvatar(roomId: string, url: string | null): Promise<void> {
      await transport().send({
        type: 'set_room_avatar',
        room_id: roomId,
        url,
      });
    },

    async setRoomJoinRule(roomId: string, rule: JoinRuleView): Promise<void> {
      await transport().send({
        type: 'set_room_join_rule',
        room_id: roomId,
        rule,
      });
    },

    async sendStateEvent(
      roomId: string,
      eventType: string,
      stateKey: string,
      content: unknown
    ): Promise<void> {
      await transport().send({
        type: 'send_state_event',
        room_id: roomId,
        event_type: eventType,
        state_key: stateKey,
        content,
      });
    },

    async setUserPowerLevel(roomId: string, userId: string, powerLevel: number): Promise<void> {
      await transport().send({
        type: 'set_user_power_level',
        room_id: roomId,
        user_id: userId,
        power_level: powerLevel,
      });
    },

    async uploadMedia(mime: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
      return transport().uploadMedia(mime, bytes);
    },

    async unsubscribe(subscription: SubscriptionId): Promise<void> {
      await transport().send({ type: 'unsubscribe', subscription });
    },
  };
}

export type CoreCommands = ReturnType<typeof createCommands>;
