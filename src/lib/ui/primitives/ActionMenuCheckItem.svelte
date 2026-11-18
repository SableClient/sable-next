<script lang="ts">
  import ActionMenuItem from './ActionMenuItem.svelte';

  interface Props {
    checked: boolean;
    kind?: 'radio' | 'checkbox';
    label: string;
    closeOnSelect?: boolean;
    onSelect: () => void;
  }

  let { checked, kind, label, closeOnSelect = true, onSelect }: Props = $props();
</script>

<ActionMenuItem {checked} {kind} {closeOnSelect} {onSelect}>
  <span class="menu-check" aria-hidden="true">{checked ? '✓' : ''}</span>
  <span>{label}</span>
</ActionMenuItem>
