<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import AccountDataExplorer, {
    type AccountDataSource,
  } from '#lib/features/settings/AccountDataExplorer.svelte';
  import { i18n } from '#lib/i18n.js';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';

  const KNOWN_TYPES = ['m.fully_read', 'm.tag', 'm.marked_unread', 'com.famedly.marked_unread'];

  interface Props {
    roomId: string;
  }

  let { roomId }: Props = $props();
  const core = useCoreClient();

  const source = $derived.by((): AccountDataSource => {
    const room_id = roomId;
    return {
      async types() {
        const listed = await core.rpc.room_state.accountDataTypes({ room_id });
        return [...new Set([...listed, ...KNOWN_TYPES])];
      },
      async read(event_type) {
        const content = await core.rpc.room_state.accountData({ room_id, event_type });
        return { content, seal: 'plain' };
      },
      async write(event_type, content) {
        await core.rpc.room_state.setAccountData({ room_id, event_type, content });
      },
      serverManaged: ['m.fully_read'],
    };
  });
</script>

<SettingsSection
  headingId="room-developer-account-data"
  title={i18n.t('room.devAccountDataTitle')}
  description={i18n.t('room.devAccountDataDescription')}
>
  <AccountDataExplorer {source} label={i18n.t('room.devAccountDataTitle')} />
</SettingsSection>
