<script lang="ts">
  import { untrack } from 'svelte';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import type {
    PersonaTriggerView,
    PersonaView,
    PersonaAlternateAvatarView,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { nativeFilePicker } from '#lib/platform/native-file-picker.js';
  import { parsePronouns } from '#lib/personas/pronouns.js';
  import { MAX_PRONOUN_INPUT, pronounText } from '#lib/profile/pronouns.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import { hexColorOrEmpty } from '#lib/ui/hex-color.js';
  import ColorSetting from '#lib/ui/ColorSetting.svelte';
  import { uprightJpeg } from '#lib/ui/upright-jpeg.js';
  import Select from '#lib/ui/primitives/Select.svelte';
  import ProhibitIcon from 'phosphor-svelte/lib/ProhibitIcon';
  import BioEditor from './BioEditor.svelte';
  import { bioContent, bioHtml, type BioContent } from './bio-content';

  interface Props {
    open?: boolean;
    persona: PersonaView | null;
    onSave: (
      persona: PersonaView,
      previousId: string | null,
      basePersona: PersonaView | null
    ) => Promise<void>;
    onOpenChange: (open: boolean) => void;
  }

  let { open = $bindable(false), persona, onSave, onOpenChange }: Props = $props();
  const core = useCoreClient();

  let name = $state('');
  let avatarUrl = $state<string | null>(null);
  let pronouns = $state('');
  let colorLight = $state('');
  let colorDark = $state('');
  let triggers = $state<(PersonaTriggerView & { id: string })[]>([]);
  let alternateAvatars = $state<{ id: string; avatar_url: string | null }[]>([]);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let biography: BioContent = $state({ body: '', formatted: '' });
  let banner_url = $state('');
  let is_animal = $state('');
  let has_animal = $state('');
  let animal_need = $state('');
  let hidden = $state(false);

  $effect(() => {
    if (!open) return;
    untrack(() => {
      name = persona?.display_name ?? '';
      avatarUrl = persona?.avatar_url ?? null;
      pronouns = pronounText(persona?.pronouns ?? []);
      colorLight = persona?.color_on_light ?? '';
      colorDark = persona?.color_on_dark ?? '';
      triggers =
        persona?.triggers.map((trigger) => ({ ...trigger, id: crypto.randomUUID() })) ?? [];
      alternateAvatars = persona?.alternate_avatars ?? [];
      biography = bioContent(persona?.biography ?? '');
      banner_url = persona?.banner_url ?? '';
      is_animal = persona?.is_animal ?? '';
      has_animal = persona?.has_animal ?? '';
      animal_need = persona?.animal_need ?? '';
      hidden = persona?.sort_flags?.hidden ?? false;
      error = null;
    });
  });

  async function pickAvatar(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    saving = true;
    error = null;
    try {
      const upright = await uprightJpeg(file);
      avatarUrl = await core.media.uploadMedia(
        upright.type || 'image/*',
        new Uint8Array(await upright.arrayBuffer())
      );
    } catch (cause) {
      console.warn('[sable personas] uploading the picture failed', cause);
      error = i18n.t('personas.saveFailed');
    } finally {
      saving = false;
    }
  }

  function addTrigger(): void {
    triggers = [
      ...triggers,
      {
        prefix: '',
        suffix: null,
        keep_trigger: false,
        id: crypto.randomUUID(),
        alternate_avatar_id: null,
      },
    ];
  }

  function removeTrigger(index: number): void {
    triggers = triggers.filter((_, position) => position !== index);
  }

  function addAlternateAvatar(): void {
    alternateAvatars = [...alternateAvatars, { avatar_url: null, id: crypto.randomUUID() }];
  }

  function removeAlternateAvatar(index: number): void {
    alternateAvatars = alternateAvatars.filter((_, position) => position !== index);
  }

  async function pickAlternateAvatar(
    index: number,
    event: Event & { currentTarget: HTMLInputElement }
  ): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    saving = true;
    error = null;
    try {
      const upright = await uprightJpeg(file);
      alternateAvatars[index].avatar_url = await core.media.uploadMedia(
        upright.type || 'image/*',
        new Uint8Array(await upright.arrayBuffer())
      );
    } catch (cause) {
      console.warn('[sable personas] uploading the picture failed', cause);
      error = i18n.t('personas.saveFailed');
    } finally {
      saving = false;
    }
  }

  async function pickBanner(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    saving = true;
    error = null;
    try {
      const upright = await uprightJpeg(file);
      banner_url = await core.media.uploadMedia(
        upright.type || 'image/*',
        new Uint8Array(await upright.arrayBuffer())
      );
    } catch (cause) {
      console.warn('[sable personas] uploading the picture failed', cause);
      error = i18n.t('personas.saveFailed');
    } finally {
      saving = false;
    }
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const displayName = name.trim();
    if (displayName === '') {
      error = i18n.t('personas.nameRequired');
      return;
    }

    const htmlBio = bioHtml(biography);
    if ((htmlBio?.length ?? 0) >= 2048) {
      error = i18n.t('personas.bioTooLong');
      return;
    }

    saving = true;
    error = null;
    try {
      await onSave(
        {
          id: persona?.id ?? crypto.randomUUID(),
          display_name: displayName,
          avatar_url: avatarUrl,
          pronouns: parsePronouns(pronouns),
          color_on_light: hexColorOrEmpty(colorLight) || null,
          color_on_dark: hexColorOrEmpty(colorDark) || null,
          triggers: triggers
            .map((trigger) => ({
              prefix: trigger.prefix?.trimStart() || null,
              suffix: trigger.suffix?.trimEnd() || null,
              keep_trigger: trigger.keep_trigger,
              alternate_avatar_id: trigger.alternate_avatar_id || null,
            }))
            .filter((trigger) => trigger.prefix !== null || trigger.suffix !== null),
          alternate_avatars: alternateAvatars.filter(
            (avatar): avatar is PersonaAlternateAvatarView => avatar.avatar_url !== null
          ),
          pluralkit: persona?.pluralkit ?? null,
          last_used: persona?.last_used ?? null,
          biography: htmlBio ? htmlBio : null,
          banner_url: banner_url ?? null,
          is_animal: is_animal ?? null,
          has_animal: has_animal ?? null,
          animal_need: animal_need ?? null,
          sort_flags: { hidden },
        },
        persona?.id ?? null,
        persona
      );
      onOpenChange(false);
    } catch (cause) {
      console.warn('[sable personas] saving failed', cause);
      error = i18n.t('personas.saveFailed');
    } finally {
      saving = false;
    }
  }
</script>

<DialogFrame bind:open variant="settings" label={i18n.t('personas.editorTitle')} {onOpenChange}>
  <form class="persona-editor" onsubmit={(event) => void submit(event)}>
    <h2>{i18n.t('personas.editorTitle')}</h2>
    {#if error}<Alert variant="critical" aria-live="polite">{error}</Alert>{/if}

    <div class="identity">
      <Avatar src={avatarUrl} {name} size="large" />
      <div class="identity-actions">
        <label class="file-button btn btn-secondary btn-small">
          <input
            use:nativeFilePicker
            type="file"
            accept="image/*"
            onchange={(event) => void pickAvatar(event)}
          />
          {i18n.t('common.chooseAPicture')}
        </label>
        {#if avatarUrl}
          <Button
            variant="danger"
            size="small"
            onclick={() => {
              avatarUrl = null;
            }}
          >
            {i18n.t('personas.avatarRemove')}
          </Button>
        {/if}
      </div>
    </div>

    <label class="field">
      <span>{i18n.t('personas.name')}</span>
      <TextInput
        name="persona-name"
        bind:value={name}
        autocomplete="off"
        required
        maxlength={128}
      />
      <small>{i18n.t('personas.nameHint')}</small>
    </label>

    <label class="field">
      <span>{i18n.t('personas.pronouns')}</span>
      <TextInput
        name="persona-pronouns"
        bind:value={pronouns}
        autocomplete="off"
        placeholder={i18n.t('common.pronounsPlaceholder')}
        maxlength={MAX_PRONOUN_INPUT}
      />
    </label>

    <div class="colors">
      <ColorSetting
        label={i18n.t('personas.colorLight')}
        bind:value={colorLight}
        onCommit={() => {}}
        onReset={() => (colorLight = '')}
      />
      <ColorSetting
        label={i18n.t('personas.colorDark')}
        bind:value={colorDark}
        onCommit={() => {}}
        onReset={() => (colorDark = '')}
      />
    </div>

    <fieldset class="triggers">
      <legend>{i18n.t('personas.triggers')}</legend>
      <p>{i18n.t('personas.triggersHint')}</p>
      {#each triggers as trigger, index (trigger.id)}
        <div class="trigger-row">
          <label class="field">
            <span>{i18n.t('personas.triggerPrefix')}</span>
            <TextInput
              name={`persona-trigger-prefix-${String(index)}`}
              value={trigger.prefix ?? ''}
              autocomplete="off"
              oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
                triggers[index] = {
                  ...trigger,
                  prefix: event.currentTarget.value,
                };
              }}
            />
          </label>
          <label class="field">
            <span>{i18n.t('personas.triggerSuffix')}</span>
            <TextInput
              name={`persona-trigger-suffix-${String(index)}`}
              value={trigger.suffix ?? ''}
              autocomplete="off"
              oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
                triggers[index] = {
                  ...trigger,
                  suffix: event.currentTarget.value,
                };
              }}
            />
          </label>
          <label class="field wrap">
            <span>{i18n.t('personas.triggerKeep')}</span>
            <Switch
              label=""
              checked={trigger.keep_trigger}
              onCheckedChange={(checked: boolean) => {
                triggers[index] = { ...trigger, keep_trigger: checked };
              }}
            />
          </label>
          <label class="field wrap">
            <span>{i18n.t('personas.triggerAlternateAvatar')}</span>
            <span
              style=" align-items: center;display: flex; flex-flow: row nowrap; gap: var(--space-100);"
            >
              <Select
                value={trigger.alternate_avatar_id ?? ''}
                placeholder={i18n.t('personas.alternateAvatarNone')}
                onValueChange={(value: string) => {
                  triggers[index] = { ...trigger, alternate_avatar_id: value ?? null };
                }}
                items={[{ value: '', label: i18n.t('personas.alternateAvatarNone') }].concat(
                  alternateAvatars.map((avatar) => {
                    return {
                      value: avatar.id,
                      label: i18n.t('personas.alternateAvatarLabel'),
                      mediaImage: avatar.avatar_url ?? undefined,
                    };
                  })
                )}
              ></Select>
              {#if trigger.alternate_avatar_id && alternateAvatars.find((avatar) => avatar.id === trigger.alternate_avatar_id)}
                <Avatar
                  src={alternateAvatars.find((avatar) => avatar.id === trigger.alternate_avatar_id)
                    ?.avatar_url}
                  {name}
                  size="small"
                />
              {:else}
                <Avatar size="small"><ProhibitIcon /></Avatar>
              {/if}
            </span>
          </label>
          <div class="button">
            <IconButton
              variant="subtle"
              size="small"
              label={i18n.t('personas.triggerRemove')}
              onclick={() => {
                removeTrigger(index);
              }}
            >
              <TrashIcon />
            </IconButton>
          </div>
        </div>
      {/each}
      <Button variant="secondary" size="small" onclick={addTrigger}>
        <PlusIcon />
        {i18n.t('personas.triggerAdd')}
      </Button>
    </fieldset>

    <fieldset class="alternateAvatars">
      <legend>{i18n.t('personas.alternateAvatars')}</legend>
      <p>{i18n.t('personas.alternateAvatarsHint')}</p>
      {#each alternateAvatars as avatar, index (avatar.id)}
        <div class="avatar-row">
          <Avatar src={avatar.avatar_url} {name} size="large" />
          <label class="file-button btn btn-secondary btn-small">
            <input
              use:nativeFilePicker
              type="file"
              accept="image/*"
              onchange={(event) => void pickAlternateAvatar(index, event)}
            />
            {i18n.t('common.chooseAPicture')}
          </label>
          {#if avatarUrl}
            <Button
              variant="danger"
              size="small"
              onclick={() => {
                removeAlternateAvatar(index);
              }}
            >
              {i18n.t('personas.avatarRemove')}
            </Button>
          {/if}
        </div>
      {/each}
      <Button variant="secondary" size="small" onclick={addAlternateAvatar}>
        <PlusIcon />
        {i18n.t('personas.alternateAvatarAdd')}
      </Button>
    </fieldset>

    <fieldset class="triggers">
      <legend>{i18n.t('settings.profile')}</legend>

      <label class="field">
        <span>{i18n.t('settings.biography')}</span>
        <BioEditor id="persona-biography" bind:value={biography} />
      </label>

      <label class="field">
        <span>{i18n.t('settings.banner')}</span>
        {#if banner_url}
          <div class="profile-card-cover">
            <MediaImage
              class={banner_url
                ? 'profile-card-banner'
                : 'profile-card-banner profile-card-banner-fallback'}
              alt=""
              source={banner_url}
              width={720}
              height={240}
              original={true}
            />
          </div>
        {/if}
        <div style="display: flex; flex-direction: row; gap: var(--space-200)">
          <Button
            variant="danger"
            size="small"
            disabled={!banner_url}
            onclick={() => {
              banner_url = '';
            }}
          >
            {i18n.t('personas.avatarRemove')}
          </Button>
          <label class="file-button btn btn-secondary btn-small">
            <input
              use:nativeFilePicker
              type="file"
              accept="image/*"
              onchange={(event) => void pickBanner(event)}
            />
            {i18n.t('common.chooseAPicture')}
          </label>
        </div>
      </label>
    </fieldset>

    <fieldset class="triggers">
      <legend>{i18n.t('settings.animalIdentity')}</legend>

      <label class="field">
        <span>{i18n.t('settings.animalIdentityWhatIs')}</span>
        <TextInput
          name="persona-animal-is"
          bind:value={is_animal}
          autocomplete="off"
          placeholder={i18n.t('settings.animalIdentityWhatIsPlaceholder')}
          maxlength={128}
        />
      </label>

      <label class="field">
        <span>{i18n.t('settings.animalIdentityWhatHas')}</span>
        <TextInput
          name="persona-animal-has"
          bind:value={has_animal}
          autocomplete="off"
          placeholder={i18n.t('settings.animalIdentityWhatHasPlaceholder')}
          maxlength={128}
        />
      </label>

      <label class="field">
        <span>{i18n.t('settings.animalIdentityWhatNeeds')}</span>
        <TextInput
          name="persona-animal-need"
          bind:value={animal_need}
          autocomplete="off"
          placeholder={i18n.t('settings.animalIdentityWhatNeedsPlaceholder')}
          maxlength={128}
        />
      </label>
    </fieldset>

    <fieldset class="triggers">
      <legend>{i18n.t('personas.editorSortFlags')}</legend>

      <label class="field inline">
        <span>{i18n.t('personas.sortFlagsHidden')}</span>
        <Switch label="" bind:checked={hidden} />
      </label>
    </fieldset>

    <DialogActions>
      <Button
        variant="secondary"
        onclick={() => {
          onOpenChange(false);
        }}
      >
        {i18n.t('common.cancel')}
      </Button>
      <Button type="submit" loading={saving}>{i18n.t('common.save')}</Button>
    </DialogActions>
  </form>
</DialogFrame>

<style>
  .persona-editor {
    align-content: start;
    block-size: 100%;
    display: grid;
    gap: var(--space-400);
    overflow: hidden auto;
    overscroll-behavior: contain;
    padding: var(--space-400);
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .identity {
    align-items: center;
    display: flex;
    gap: var(--space-400);
  }

  .identity-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }

  .file-button {
    cursor: pointer;
  }

  .file-button input {
    height: 1px;
    opacity: 0;
    position: absolute;
    width: 1px;
  }

  .field {
    display: grid;
    gap: var(--space-200);
    min-width: 0;
  }

  .field span {
    font-weight: var(--font-weight-medium);
  }

  .field small {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .field.inline {
    display: flex;
    flex-flow: row nowrap;
    justify-content: space-between;
  }

  .colors {
    display: grid;
    gap: var(--space-300);
  }

  fieldset {
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-300);
    margin: 0;
    padding: var(--space-300) var(--space-400) var(--space-400);
  }

  fieldset legend {
    font-weight: var(--font-weight-medium);
    padding: 0 var(--space-200);
  }

  fieldset p {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .trigger-row {
    align-items: center;
    column-gap: var(--space-300);
    display: grid;
    grid-template-columns: 1fr 1fr auto auto;
  }

  .trigger-row .field {
    align-items: center;
    grid-row: 1 / 3;
    grid-template-rows: auto auto;
    grid-template-rows: subgrid;
  }

  .trigger-row .button {
    grid-row: 2 / 3;
  }

  @media (width < 34rem) {
    .trigger-row {
      grid-template-columns: 1fr 1fr auto;
      grid-template-rows: auto auto var(--space-300) auto var(--space-300) auto;
    }

    .trigger-row .field.wrap {
      grid-column: 1 / 4;
      grid-row: 4 / 5;
      grid-template-columns: 1fr auto;
    }

    /* hack sorry */
    .trigger-row .field.wrap:nth-child(4) {
      grid-row: 6 / 7;
    }

    fieldset {
      gap: var(--space-600);
    }
  }

  .avatar-row {
    align-items: center;
    column-gap: var(--space-300);
    display: grid;
    grid-template-columns: 1fr auto auto;
  }

  .profile-card-cover {
    height: 7rem;
    overflow: hidden;
  }

  .profile-card-cover :global(.profile-card-banner img) {
    object-fit: cover;
    object-position: center;
  }
</style>
