<script lang="ts">
  import type { OutlineTracker } from './settings-outline.svelte.js';

  interface Props {
    outline: OutlineTracker;
    label: string;
  }

  let { outline, label }: Props = $props();
  let activeIndex = $derived(outline.entries.findIndex((entry) => entry.id === outline.activeId));
</script>

<ul
  class="settings-outline"
  class:tracking={activeIndex >= 0}
  aria-label={label}
  style:--outline-index={Math.max(0, activeIndex)}
>
  {#each outline.entries as entry (entry.id)}
    {@const active = entry.id === outline.activeId}
    <li>
      <a
        href={`#${entry.id}`}
        aria-current={active ? 'location' : undefined}
        onclick={(event) => {
          if (event.shiftKey || event.metaKey || event.ctrlKey || event.button !== 0) return;

          event.preventDefault();
          outline.jump(entry.id);
        }}>{entry.label}</a
      >
    </li>
  {/each}
</ul>

<style>
  .settings-outline {
    --outline-row: var(--control-height-small);

    border-inline-start: var(--border-width) solid var(--bg-container-line);
    list-style: none;
    margin: var(--space-050) 0 var(--space-100) calc(var(--space-300) + var(--icon-size-small) / 2);
    padding: 0;
    position: relative;
  }

  .settings-outline::before {
    background: var(--bg-on-container);
    block-size: calc(var(--outline-row) - var(--space-200));
    border-radius: var(--radii-200);
    content: '';
    inline-size: calc(var(--border-width) * 2);
    inset-block-start: var(--space-100);
    inset-inline-start: calc(var(--border-width) * -1.5);
    opacity: 0;
    pointer-events: none;
    position: absolute;
    transform: translateY(calc(var(--outline-index) * var(--outline-row)));
    transition:
      transform var(--duration-fast) var(--ease-smooth-out),
      opacity var(--duration-fast) ease;
  }

  .tracking::before {
    opacity: 1;
  }

  a {
    align-items: center;
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-label);
    height: var(--outline-row);
    overflow: hidden;
    padding-inline: calc(var(--icon-size-small) / 2 + var(--space-300)) var(--space-300);
    text-decoration: none;
    text-overflow: ellipsis;
    transition: color var(--duration-fast) ease;
    white-space: nowrap;
  }

  a:hover {
    color: var(--bg-on-container);
  }

  a:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(var(--focus-ring-width) * -1);
  }

  a[aria-current='location'] {
    color: var(--bg-on-container);
    font-weight: var(--font-weight-medium);
  }
</style>
