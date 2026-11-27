<script lang="ts">
  import { setSealedAccountData } from '#lib/core/api/account.svelte.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import AccountDataExplorer, { type AccountDataSource } from './AccountDataExplorer.svelte';

  const core = useCoreClient();

  const source = $derived.by((): AccountDataSource => {
    void core.session?.account_id;
    return {
      types: () => core.rpc.account.dataTypes(),
      async read(type) {
        if (!type.startsWith('m.') && type.includes('.')) {
          const sealed = await core.rpc.account.sealedData({ event_type: type });
          if (sealed.state === 'sealed') return { content: sealed.content, seal: 'sealed' };
          if (sealed.state === 'locked') {
            return { content: await core.rpc.account.data({ event_type: type }), seal: 'locked' };
          }
        }
        return { content: await core.rpc.account.data({ event_type: type }), seal: 'plain' };
      },
      async write(type, content, seal) {
        if (seal === 'sealed') await setSealedAccountData(core.rpc, type, content);
        else await core.rpc.account.setData({ event_type: type, content });
      },
      serverManaged: ['m.push_rules', 'm.fully_read'],
    };
  });
</script>

{#if core.session}
  <AccountDataExplorer {source} label={i18n.t('settings.developerAccountDataTitle')} />
{/if}
