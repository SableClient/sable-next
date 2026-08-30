<script lang="ts">
  import type { ImagePackView } from '#src/generated/ImagePackView';

  import { useCoreClient } from '#lib/core/context.js';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import ImagePackEditor from './ImagePackEditor.svelte';
  import { USER_EMOTES_EVENT_TYPE } from './pack-address.js';
  import { packEventContent, type PackDraft } from './pack-content.js';

  const core = useCoreClient();

  let pack = $state.raw<ImagePackView | null>(null);
  let loading = $state(true);
  let alive = true;

  $effect(() => {
    void load().finally(() => {
      if (alive) loading = false;
    });

    return () => {
      alive = false;
    };
  });

  async function load(): Promise<void> {
    try {
      const packs = await core.commands.allImagePacks();
      if (!alive) return;
      pack = packs.find((candidate) => candidate.origin === 'account') ?? null;
    } catch (error) {
      console.warn('[sable emotes] the personal pack could not be read', error);
    }
  }

  async function apply(draft: PackDraft): Promise<void> {
    await core.commands.setAccountData(USER_EMOTES_EVENT_TYPE, packEventContent(draft));
  }
</script>

{#if loading}
  <p class="status" role="status"><Spinner small /></p>
{:else}
  <ImagePackEditor {pack} canEdit onApply={apply} />
{/if}

<style>
  .status {
    color: var(--sable-surface-var-on-container);
    margin: 0;
    padding: var(--space-400) 0;
    text-align: center;
  }
</style>
