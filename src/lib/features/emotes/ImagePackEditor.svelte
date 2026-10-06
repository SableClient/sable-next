<script lang="ts">
  import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon';
  import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon';
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import UploadSimpleIcon from 'phosphor-svelte/lib/UploadSimpleIcon';

  import type { ImagePackView, ImageUsageView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { pickFiles } from '#lib/platform/files.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Switcher from '#lib/ui/primitives/Switcher.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { holdUnsaved } from '#lib/ui/unsaved-guard.js';
  import { uprightJpeg } from '#lib/ui/upright-jpeg.js';

  import {
    ALL_USAGES,
    emptyDraft,
    invalidShortcode,
    normalizeShortcode,
    packDraft,
    shortcodeWithoutExtension,
    setImageUsage,
    togglePackUsage,
    uniqueShortcode,
    type PackDraft,
    type PackImageDraft,
  } from './pack-content.js';
  import { exportPacks, importArchive } from './pack-transfer.js';
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
  let avatarUploading = $state(false);
  let failed = $state(false);
  let renaming = $state<string | null>(null);
  let renameDraft = $state('');
  let shortcode = $state('');
  let imageInput = $state<HTMLInputElement | null>(null);
  let avatarInput = $state<HTMLInputElement | null>(null);
  let archiveInput = $state<HTMLInputElement | null>(null);
  let transferFailed = $state<'export' | 'import' | null>(null);

  let dirty = $derived(draft !== null);
  let rejected = $derived(draft === null ? null : invalidShortcode(draft.images));
  let leaving = $state.raw<{ proceed: () => void; stay?: () => void } | null>(null);

  holdUnsaved({
    dirty: () => canEdit && dirty && leaving === null,
    ask: (proceed, stay) => {
      leaving = { proceed, stay };
    },
  });

  function edit(next: PackDraft): void {
    draft = next;
    failed = false;
    transferFailed = null;
  }

  function taken(candidate: string): boolean {
    return current.images.some((image) => image.shortcode === candidate);
  }

  function toggleUsage(usage: ImageUsageView, on: boolean): void {
    const next = togglePackUsage(current, usage, on);
    if (next !== null) edit(next);
  }

  function imageUsageChoice(image: PackImageDraft): string {
    return image.usage.length === 1 ? image.usage[0] : 'both';
  }

  function chooseImageUsage(image: PackImageDraft, choice: string): void {
    edit(
      setImageUsage(
        current,
        image.shortcode,
        choice === 'both' ? ALL_USAGES : [choice as ImageUsageView]
      )
    );
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
      // pack usage so the per-image usage key is omitted on the wire
      const packUsage = current.usage;
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
          usage: packUsage,
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
    avatarUploading = true;
    failed = false;
    try {
      const upright = await uprightJpeg(file);
      const bytes = new Uint8Array(await upright.arrayBuffer());
      const avatarUrl = await core.commands.uploadMedia(upright.type || 'image/*', bytes);
      await onApply?.({ ...$state.snapshot(saved), avatarUrl });
      if (draft !== null) draft = { ...draft, avatarUrl };
    } catch (error) {
      console.warn('[sable emotes] the pack avatar could not be saved', error);
      failed = true;
    } finally {
      avatarUploading = false;
      busy = false;
    }
  }

  async function exportPack(): Promise<void> {
    if (busy) return;

    busy = true;
    transferFailed = null;
    try {
      if ((await exportPacks(core, [$state.snapshot(current)])) === 'failed') {
        transferFailed = 'export';
      }
    } catch (error) {
      console.warn('[sable emotes] the pack could not be exported', error);
      transferFailed = 'export';
    } finally {
      busy = false;
    }
  }

  async function importArchives(files: File[]): Promise<void> {
    if (files.length === 0 || busy) return;

    busy = true;
    transferFailed = null;
    try {
      const imported = (
        await Promise.all(
          files.map(async (file) => importArchive(core, new Uint8Array(await file.arrayBuffer())))
        )
      ).flat();

      const added: PackImageDraft[] = [];
      for (const image of imported.flatMap((pack) => pack.images)) {
        added.push({
          ...image,
          shortcode: uniqueShortcode(
            image.shortcode,
            (candidate) => taken(candidate) || added.some((entry) => entry.shortcode === candidate)
          ),
        });
      }

      const [first] = imported;
      edit({
        ...current,
        name: current.name === '' ? (first?.name ?? '') : current.name,
        avatarUrl: current.avatarUrl ?? first?.avatarUrl ?? null,
        attribution: current.attribution === '' ? (first?.attribution ?? '') : current.attribution,
        images: [...current.images, ...added],
      });
    } catch (error) {
      console.warn('[sable emotes] the pack file could not be read', error);
      transferFailed = 'import';
    } finally {
      busy = false;
    }
  }

  async function chooseArchive(): Promise<void> {
    if (busy) return;

    const picked = await pickFiles('*/*');
    if (picked === null) archiveInput?.click();
    else await importArchives(picked);
  }

  async function apply(): Promise<boolean> {
    if (draft === null || busy) return false;

    busy = true;
    failed = false;
    try {
      await onApply?.($state.snapshot(draft));
      draft = null;
      return true;
    } catch (error) {
      console.warn('[sable emotes] the pack could not be saved', error);
      failed = true;
      return false;
    } finally {
      busy = false;
    }
  }

  function stay(): void {
    const pending = leaving;
    leaving = null;
    pending?.stay?.();
  }

  function discardAndLeave(): void {
    const pending = leaving;
    leaving = null;
    draft = null;
    pending?.proceed();
  }

  async function saveAndLeave(): Promise<void> {
    const pending = leaving;
    if (!(await apply())) return;
    leaving = null;
    pending?.proceed();
  }
</script>

<div class="pack-editor">
  {#if transferFailed !== null}
    <Alert variant="critical" role="alert">
      {transferFailed === 'export'
        ? $i18n.t('emotes.exportFailed')
        : $i18n.t('emotes.importFailed')}
    </Alert>
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
          source={current.avatarUrl ?? pack?.avatar_url ?? current.images[0]?.url ?? ''}
          alt=""
          width={56}
          height={56}
          original
        />
        {#if canEdit}
          <Button
            size="small"
            disabled={busy}
            loading={avatarUploading}
            onclick={() => avatarInput?.click()}
          >
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
          placeholder={pack?.name ?? ''}
          readonly={!canEdit}
          oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
            edit({ ...current, name: event.currentTarget.value });
          }}
        />
      </FormField>
      <FormField fieldId="pack-attribution" label={$i18n.t('emotes.packAttribution')}>
        <TextArea
          id="pack-attribution"
          value={current.attribution}
          rows={3}
          readonly={!canEdit}
          oninput={(event: Event & { currentTarget: HTMLTextAreaElement }) => {
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
              <MediaImage
                source={image.url}
                alt={image.shortcode}
                width={24}
                height={24}
                original
              />
            {/snippet}
            <Switcher
              label={$i18n.t('emotes.imageUsage', { shortcode: image.shortcode })}
              value={imageUsageChoice(image)}
              disabled={!canEdit || busy}
              items={[
                { value: 'emoticon', label: $i18n.t('emotes.usageEmoji') },
                { value: 'sticker', label: $i18n.t('emotes.usageSticker') },
                { value: 'both', label: $i18n.t('emotes.usageBoth') },
              ]}
              onValueChange={(choice) => {
                chooseImageUsage(image, choice);
              }}
            />
            {#if renaming === image.shortcode}
              <TextInput
                bind:value={renameDraft}
                aria-label={$i18n.t('emotes.shortcode')}
                onblur={() => {
                  commitRename(image);
                }}
                onkeydown={(event: KeyboardEvent) => {
                  if (event.key === 'Enter') {
                    commitRename(image);
                    if (rejected === null) void apply();
                  }
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
      <p class="status settings-form">{$i18n.t('emotes.noImages')}</p>
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

  <SettingsSection
    headingId="pack-transfer"
    title={$i18n.t('emotes.transfer')}
    description={$i18n.t('emotes.transferHint')}
  >
    <div class="transfer settings-form">
      <Button
        size="small"
        disabled={busy || current.images.length === 0}
        onclick={() => {
          void exportPack();
        }}
      >
        <DownloadSimpleIcon />
        {$i18n.t('emotes.export')}
      </Button>
      {#if canEdit}
        <Button
          size="small"
          disabled={busy}
          onclick={() => {
            void chooseArchive();
          }}
        >
          <UploadSimpleIcon />
          {$i18n.t('emotes.import')}
        </Button>
        <input
          bind:this={archiveInput}
          class="file-input"
          type="file"
          accept=".zip,application/zip"
          multiple
          tabindex="-1"
          aria-hidden="true"
          onchange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = '';
            void importArchives(files);
          }}
        />
      {/if}
    </div>
  </SettingsSection>

  {#if canEdit}
    {#if rejected !== null}
      <Alert variant="warning" role="alert" title={$i18n.t('emotes.invalidShortcodeTitle')}>
        <p>{$i18n.t('emotes.invalidShortcode', { shortcode: rejected })}</p>
      </Alert>
    {/if}
    {#if failed}
      <Alert variant="critical" role="alert">{$i18n.t('emotes.saveFailed')}</Alert>
    {/if}
    <div class="save-bar" class:pending={dirty}>
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
        disabled={!dirty || busy || rejected !== null}
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

{#if leaving !== null}
  <DialogFrame
    open
    variant="verification"
    label={$i18n.t('emotes.leaveTitle')}
    onOpenChange={(next) => {
      if (!next) stay();
    }}
  >
    <div class="leave">
      <h2>{$i18n.t('emotes.leaveTitle')}</h2>
      <p>{$i18n.t('emotes.leaveHint')}</p>
      {#if failed}
        <Alert variant="critical" role="alert">{$i18n.t('emotes.saveFailed')}</Alert>
      {/if}
      <DialogActions>
        <Button onclick={stay} disabled={busy}>{$i18n.t('emotes.leaveStay')}</Button>
        <Button variant="danger" onclick={discardAndLeave} disabled={busy}>
          {$i18n.t('emotes.leaveDiscard')}
        </Button>
        <Button
          variant="primary"
          loading={busy}
          disabled={rejected !== null}
          onclick={() => {
            void saveAndLeave();
          }}
        >
          {$i18n.t('emotes.leaveSave')}
        </Button>
      </DialogActions>
    </div>
  </DialogFrame>
{/if}

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
    color: var(--surface-var-on-container);
    margin: 0;
    text-align: center;
  }

  .transfer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
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

  .save-bar.pending {
    background: var(--bg-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radius);
    bottom: var(--space-300);
    box-shadow: var(--shadow-e200);
    color: var(--bg-on-container);
    padding: var(--space-200) var(--space-300);
    position: sticky;
    z-index: 1;
  }

  .leave {
    display: grid;
    gap: var(--space-300);
    width: min(24rem, calc(100vw - 2rem));
  }

  .leave h2,
  .leave p {
    margin: 0;
  }

  .save-status {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    margin-right: auto;
  }

  .save-bar.pending .save-status {
    color: var(--bg-on-container);
    font-weight: var(--font-weight-medium);
  }
</style>
