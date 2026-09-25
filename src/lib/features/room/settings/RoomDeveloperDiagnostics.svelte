<script lang="ts">
  import type { RoomSummary } from '#src/generated/protocol';
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import '#lib/ui/primitives/settings-row.css';

  interface Props {
    room: RoomSummary;
  }

  let { room }: Props = $props();
  const core = useCoreClient();

  let fullyRead = $state<string | null>(null);

  let diagnostics = $derived({
    room_id: room.room_id,
    membership: room.state,
    sync: core.sync?.state ?? 'offline',
    core_status: core.status,
    unread: room.unread,
    notifying: room.notifying,
    highlight: room.highlight,
    marked_unread: room.marked_unread,
    latest_event_id: room.latest_event?.event_id ?? null,
    fully_read: fullyRead,
    read_latest: fullyRead !== null && fullyRead === (room.latest_event?.event_id ?? null),
  });

  $effect(() => {
    const target = room.room_id;
    let current = true;
    void readFullyRead(target).then((eventId) => {
      if (current) fullyRead = eventId;
    });
    return () => {
      current = false;
    };
  });

  async function readFullyRead(target: string): Promise<string | null> {
    try {
      const content = await core.commands.roomAccountData(target, 'm.fully_read');
      const eventId = (content as { event_id?: unknown } | null)?.event_id;
      return typeof eventId === 'string' ? eventId : null;
    } catch (error) {
      console.debug('[sable room] read marker unavailable', error);
      return null;
    }
  }

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      toasts.info($i18n.t('room.devCopied'));
    } catch (error) {
      console.warn('[sable room] copy failed', error);
    }
  }
</script>

<SettingsSection headingId="room-developer-room" title={$i18n.t('room.devRoomTitle')}>
  <ul class="settings-rows">
    <SettingsRow title={$i18n.t('room.devRoomId')} description={room.room_id}>
      <IconButton
        variant="subtle"
        size="small"
        label={$i18n.t('room.devCopyRoomId')}
        onclick={() => void copy(room.room_id)}
      >
        <CopyIcon />
      </IconButton>
    </SettingsRow>
  </ul>
</SettingsSection>

<SettingsSection
  headingId="room-developer-diagnostics"
  title={$i18n.t('room.devDiagnosticsTitle')}
  description={$i18n.t('room.devDiagnosticsDescription')}
>
  <ul class="settings-rows">
    <SettingsRow title={$i18n.t('room.devDiagSync')}>
      <code>{diagnostics.sync} · {diagnostics.core_status}</code>
    </SettingsRow>
    <SettingsRow title={$i18n.t('room.devDiagMembership')}>
      <code>{diagnostics.membership}</code>
    </SettingsRow>
    <SettingsRow title={$i18n.t('room.devDiagUnread')}>
      <code
        >{diagnostics.unread} / {diagnostics.notifying} / {diagnostics.highlight}{diagnostics.marked_unread
          ? ' · marked'
          : ''}</code
      >
    </SettingsRow>
    <SettingsRow
      title={$i18n.t('room.devDiagFullyRead')}
      description={diagnostics.fully_read ?? '-'}
    />
    <SettingsRow
      title={$i18n.t('room.devDiagLatest')}
      description={`${diagnostics.latest_event_id ?? '-'} · ${
        diagnostics.read_latest ? $i18n.t('room.devDiagRead') : $i18n.t('room.devDiagNotRead')
      }`}
    />
  </ul>
  <div class="settings-form">
    <div>
      <Button
        size="small"
        variant="secondary"
        onclick={() => void copy(JSON.stringify(diagnostics, null, 2))}
      >
        {$i18n.t('room.devDiagCopy')}
      </Button>
    </div>
  </div>
</SettingsSection>
