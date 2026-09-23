<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { FOLDER_NAME_MAX_LENGTH, type SidebarFolder } from '#lib/spaces/sidebar-layout.js';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
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

  function submit(): void {
    if (folder === null) return;

    onRename(folder.id, draft);
    onOpenChange(false);
  }
</script>

<ConfirmDialog
  open={folder !== null}
  {onOpenChange}
  title={$i18n.t('nav.folderRename')}
  description={$i18n.t('nav.folderRenameDescription')}
  confirmLabel={$i18n.t('nav.folderSave')}
  confirmVariant="secondary"
  cancelLabel={$i18n.t('nav.folderCancel')}
  onConfirm={submit}
  onCancel={() => {
    onOpenChange(false);
  }}
>
  <FormField {fieldId} label={$i18n.t('nav.folderName')}>
    <TextInput id={fieldId} bind:value={draft} maxlength={FOLDER_NAME_MAX_LENGTH} />
  </FormField>
</ConfirmDialog>
