<script lang="ts">
  import type { SearchContextView } from '#src/generated/protocol';

  interface Props {
    line: SearchContextView;
    sender: string;
  }

  let { line, sender }: Props = $props();
</script>

<span class="hit-context" hidden={line.body.startsWith('mxc://')}>
  <span class="hit-context-sender">{sender}</span>
  {line.body}
</span>

<style>
  .hit-context {
    color: var(--surface-var-on-container);
    display: none;
    font-size: var(--font-size-small);
    opacity: 0.75;
    overflow: hidden;
    padding-inline-start: calc(var(--avatar-size-small) + var(--space-300));
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (--app-layout) {
    .hit-context:not([hidden]) {
      display: block;
    }
  }

  .hit-context-sender {
    font-weight: var(--font-weight-medium);
  }
</style>
