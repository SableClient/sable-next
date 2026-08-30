<script lang="ts">
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon';
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import type { ImagePackView } from '#src/generated/ImagePackView';
  import type { ImageUsageView } from '#src/generated/ImageUsageView';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import {
    ALL_USAGES,
    emptyDraft,
    normalizeShortcode,
    packDraft,
    shortcodeWithoutExtension,
    uniqueShortcode,
    type PackDraft,
    type PackImageDraft,
  } from './pack-content.js';
  import { readImageInfo } from './read-image-info.js';

  import '#lib/ui/primitives/settings-row.css';

  interface Props {
    pack: ImagePackView | null;
    canEdit: boolean;
    onApply?: (draft: PackDraft) => Promise<void>;
  }

  let { pack, canEdit, onApply }: Props = $props();
  const core = useCoreClient();

  let saved = $derived(pack ? packDraft(pack) : emptyDraft());
  let draft = $state<PackDraft | null>(null);
  let current = $derived(draft ?? saved);
  let busy = $state(false);
  let failed = $state(false);
  let renaming = $state<string | null>(null);
  let renameDraft = $state('');
  let shortcode = $state('');
  let imageInput = $state<HTMLInputElement | null>(null);
  let avatarInput = $state<HTMLInputElement | null>(null);

  let dirty = $derived(draft !== null);

  function edit(next: PackDraft): void {
    draft = next;
    failed = false;
  }

  function taken(candidate: string): boolean {
    return current.images.some((image) => image.shortcode === candidate);
  }

  function toggleUsage(usage: ImageUsageView, on: boolean): void {
    const next = on
      ? ALL_USAGES.filter((entry) => current.usage.includes(entry) || entry === usage)
      : current.usage.filter((entry) => entry !== usage);
    if (next.length === 0) return;

    edit({ ...current, usage: next });
  }

  function removeImage(target: PackImageDraft): void {
    edit({
      ...current,
      images: current.images.filter((image) => image.shortcode !== target.shortcode),
    });
  }

  function commitRename(target: PackImageDraft): void {
    const wanted = normalizeShortcode(renameDraft);
    renaming = null;
    if (wanted === '' || wanted === target.shortcode) return;

    const next = uniqueShortcode(wanted, taken);
    edit({
      ...current,
      images: current.images.map((image) =>
        image.shortcode === target.shortcode ? { ...image, shortcode: next } : image
      ),
    });
  }

  async function addImages(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = '';
    if (files.length === 0 || busy) return;

    busy = true;
    failed = false;
    try {
      const added: PackImageDraft[] = [];
      const requested = normalizeShortcode(shortcode);
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const url = await core.commands.uploadMedia(file.type || 'image/*', bytes);
        const wanted =
          files.length === 1 && requested !== ''
            ? requested
            : normalizeShortcode(shortcodeWithoutExtension(file.name));
        const name = uniqueShortcode(
          wanted,
          (candidate) => taken(candidate) || added.some((image) => image.shortcode === candidate)
        );
        added.push({
          shortcode: name,
          url,
          body: null,
          usage: ALL_USAGES,
          info: await readImageInfo(file),
        });
      }
      shortcode = '';
      edit({ ...current, images: [...current.images, ...added] });
    } catch (error) {
      console.warn('[sable emotes] the image could not be uploaded', error);
      failed = true;
    } finally {
      busy = false;
    }
  }

  async function setAvatar(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || busy) return;

    busy = true;
    failed = false;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      edit({
        ...current,
        avatarUrl: await core.commands.uploadMedia(file.type || 'image/*', bytes),
      });
    } catch (error) {
      console.warn('[sable emotes] the pack avatar could not be uploaded', error);
      failed = true;
    } finally {
      busy = false;
    }
  }

  async function apply(): Promise<void> {
    if (draft === null || busy) return;

    busy = true;
    failed = false;
    try {
      await onApply?.(draft);
      draft = null;
    } catch (error) {
      console.warn('[sable emotes] the pack could not be saved', error);
      failed = true;
    } finally {
      busy = false;
    }
  }
</script>

<div class="pack-editor">
  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('emotes.saveFailed')}</Alert>
  {/if}

  <SettingsSection
    headingId="pack-meta"
    title={$i18n.t('emotes.packDetails')}
    description={$i18n.t('emotes.packDetailsHint')}
  >
    <div class="settings-form">
      <div class="meta">
        <MediaImage
          class="pack-avatar"
          source={current.avatarUrl ?? current.images[0]?.url ?? ''}
          alt=""
          width={56}
          height={56}
        />
        {#if canEdit}
          <Button size="small" disabled={busy} onclick={() => avatarInput?.click()}>
            {$i18n.t('emotes.changeAvatar')}
          </Button>
          <input
            bind:this={avatarInput}
            class="file-input"
            type="file"
            accept="image/*"
            tabindex="-1"
            aria-hidden="true"
            onchange={(event) => {
              void setAvatar(event);
            }}
          />
        {/if}
      </div>

      <FormField fieldId="pack-name" label={$i18n.t('emotes.packName')}>
        <TextInput
          id="pack-name"
          value={current.name}
          readonly={!canEdit}
          oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
            edit({ ...current, name: event.currentTarget.value });
          }}
        />
      </FormField>
      <FormField fieldId="pack-attribution" label={$i18n.t('emotes.packAttribution')}>
        <TextInput
          id="pack-attribution"
          value={current.attribution}
          readonly={!canEdit}
          oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
            edit({ ...current, attribution: event.currentTarget.value });
          }}
        />
      </FormField>
    </div>

    <ul class="settings-rows">
      {#each ALL_USAGES as usage (usage)}
        {@const label =
          usage === 'emoticon' ? $i18n.t('emotes.useAsEmoji') : $i18n.t('emotes.useAsSticker')}
        <SettingsRow title={label}>
          <Switch
            {label}
            checked={current.usage.includes(usage)}
            disabled={!canEdit || busy}
            onCheckedChange={(checked) => {
              toggleUsage(usage, checked);
            }}
          />
        </SettingsRow>
      {/each}
    </ul>
  </SettingsSection>

  <SettingsSection
    headingId="pack-images"
    title={$i18n.t('emotes.images')}
    description={$i18n.t('emotes.imageCount', { count: current.images.length })}
  >
    {#if current.images.length > 0}
      <ul class="settings-rows">
        {#each current.images as image (image.shortcode)}
          <SettingsRow title=":{image.shortcode}:">
            {#snippet before()}
              <MediaImage source={image.url} alt={image.shortcode} width={24} height={24} />
            {/snippet}
            {#if renaming === image.shortcode}
              <TextInput
                bind:value={renameDraft}
                aria-label={$i18n.t('emotes.shortcode')}
                onblur={() => {
                  commitRename(image);
                }}
                onkeydown={(event: KeyboardEvent) => {
                  if (event.key === 'Enter') commitRename(image);
                  if (event.key === 'Escape') renaming = null;
                }}
              />
            {:else if canEdit}
              <IconButton
                variant="ghost"
                size="small"
                label={$i18n.t('emotes.rename', { shortcode: image.shortcode })}
                disabled={busy}
                onclick={() => {
                  renaming = image.shortcode;
                  renameDraft = image.shortcode;
                }}
              >
                <PencilSimpleIcon />
              </IconButton>
              <IconButton
                variant="ghost"
                size="small"
                label={$i18n.t('emotes.remove', { shortcode: image.shortcode })}
                disabled={busy}
                onclick={() => {
                  removeImage(image);
                }}
              >
                <TrashIcon />
              </IconButton>
            {/if}
          </SettingsRow>
        {/each}
      </ul>
    {:else}
      <p class="status">{$i18n.t('emotes.noImages')}</p>
    {/if}

    {#if canEdit}
      <div class="settings-form">
        <div class="inline">
          <TextInput
            bind:value={shortcode}
            placeholder={$i18n.t('emotes.shortcodePlaceholder')}
            aria-label={$i18n.t('emotes.shortcode')}
          />
          <Button disabled={busy} onclick={() => imageInput?.click()}>
            {$i18n.t('emotes.upload')}
          </Button>
        </div>
        <input
          bind:this={imageInput}
          class="file-input"
          type="file"
          accept="image/*"
          multiple
          tabindex="-1"
          aria-hidden="true"
          onchange={(event) => {
            void addImages(event);
          }}
        />
      </div>
    {/if}
  </SettingsSection>

  {#if canEdit}
    <div class="save-bar">
      {#if dirty}
        <p class="save-status" role="status">{$i18n.t('emotes.unsaved')}</p>
      {/if}
      <Button
        size="small"
        disabled={!dirty || busy}
        onclick={() => {
          draft = null;
          renaming = null;
        }}
      >
        <ArrowCounterClockwiseIcon />
        {$i18n.t('emotes.reset')}
      </Button>
      <Button
        size="small"
        variant="primary"
        disabled={!dirty || busy}
        loading={busy}
        onclick={() => {
          void apply();
        }}
      >
        {$i18n.t('emotes.apply')}
      </Button>
    </div>
  {/if}
</div>

<style>
  .pack-editor {
    display: grid;
    gap: var(--space-300);
  }

  .meta {
    align-items: center;
    display: flex;
    gap: var(--space-300);
  }

  :global(.pack-avatar) {
    border-radius: var(--radius);
    object-fit: contain;
  }

  .status {
    color: var(--sable-surface-var-on-container);
    margin: 0;
    padding: var(--space-400) 0;
    text-align: center;
  }

  .inline {
    display: grid;
    gap: var(--space-300);
    grid-template-columns: 1fr auto;
  }

  .file-input {
    height: 0;
    opacity: 0;
    position: absolute;
    width: 0;
  }

  .save-bar {
    align-items: center;
    display: flex;
    gap: var(--space-400);
    justify-content: flex-end;
  }

  .save-status {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    margin-right: auto;
  }
</style>
