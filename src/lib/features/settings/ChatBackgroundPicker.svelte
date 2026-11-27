<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { nativeFilePicker } from '#lib/platform/native-file-picker.js';
  import { downscaledImage } from '#lib/ui/downscale-image.js';
  import ColorSetting from '#lib/ui/ColorSetting.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import '#lib/ui/primitives/file-button.css';

  interface Props {
    id: string;
    image: string;
    color: string;
    onImage: (image: string) => void;
    onColor: (color: string) => void;
  }

  let { id, image, color, onImage, onColor }: Props = $props();

  const PICTURE_EDGE = 2560;

  const core = useCoreClient();

  let draft = $derived(color);
  let uploading = $state(false);

  async function upload(file: File): Promise<void> {
    uploading = true;
    try {
      const picture = await downscaledImage(file, PICTURE_EDGE, true);
      const bytes = new Uint8Array(await picture.arrayBuffer());
      onImage(await core.media.uploadMedia(picture.type, bytes));
    } catch (error) {
      console.warn('[sable settings] chat background upload failed', error);
      toasts.error(i18n.t('errors.actionFailed'));
    } finally {
      uploading = false;
    }
  }
</script>

<div class="chat-background-picker">
  <div class="actions">
    <label class="file-button btn btn-secondary btn-small">
      <input
        {id}
        use:nativeFilePicker
        type="file"
        accept="image/*"
        disabled={uploading}
        onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void upload(file);
        }}
      />
      {i18n.t('settings.chatBackgroundChoose')}
    </label>
    {#if image !== ''}
      <Button
        variant="ghost"
        size="small"
        onclick={() => {
          onImage('');
        }}
      >
        {i18n.t('settings.chatBackgroundRemove')}
      </Button>
    {/if}
  </div>
  <ColorSetting
    label={i18n.t('settings.chatBackgroundColor')}
    bind:value={draft}
    onCommit={() => {
      onColor(draft);
    }}
    onReset={() => {
      draft = '';
      onColor('');
    }}
  />
</div>

<style>
  .chat-background-picker {
    display: grid;
    gap: var(--space-150);
  }

  .actions {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }
</style>
