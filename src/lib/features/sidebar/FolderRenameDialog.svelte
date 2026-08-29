<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { FOLDER_NAME_MAX_LENGTH, type SidebarFolder } from '#lib/spaces/sidebar-layout.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    folder: SidebarFolder | null;
    shownName: string;
    onOpenChange: (open: boolean) => void;
    onRename: (folderId: string, name: string) => void;
  }

  let { folder, shownName, onOpenChange, onRename }: Props = $props();
  const fieldId = $props.id();
  let draft = $state('');
  let editing: string | null = null;

  $effect(() => {
    if (folder === null) {
      editing = null;
      return;
    }
    if (editing === folder.id) return;

    editing = folder.id;
    draft = folder.name ?? shownName;
  });

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (folder === null) return;

    onRename(folder.id, draft);
    onOpenChange(false);
  }
</script>

<DialogFrame
  open={folder !== null}
  {onOpenChange}
  variant="verification"
  label={$i18n.t('nav.folderRename')}
>
  <form class="rename" onsubmit={submit}>
    <h2>{$i18n.t('nav.folderRename')}</h2>
    <p class="explain">{$i18n.t('nav.folderRenameDescription')}</p>
    <FormField {fieldId} label={$i18n.t('nav.folderName')}>
      <TextInput id={fieldId} bind:value={draft} maxlength={FOLDER_NAME_MAX_LENGTH} /></FormField
    >
    <div class="actions">
      <Button
        type="button"
        variant="ghost"
        onclick={() => {
          onOpenChange(false);
        }}
      >
        {$i18n.t('nav.folderCancel')}
      </Button>
      <Button type="submit">{$i18n.t('nav.folderSave')}</Button>
    </div>
  </form>
</DialogFrame>

<style>
  .rename {
    display: grid;
    gap: var(--space-3);
    width: min(26rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-large);
    margin: 0;
  }

  .explain {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-1);
    justify-content: flex-end;
  }
</style>
