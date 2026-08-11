<script lang="ts">
  import { resolve } from '$app/paths';
  import { i18n } from '$lib/i18n';
</script>

<svelte:head>
  <title>{$i18n.t('nav.home')} · Sable</title>
</svelte:head>

<section class="empty-state" aria-labelledby="welcome-heading">
  <div class="empty-state-content">
    <p class="eyebrow">{$i18n.t('nav.home')}</p>
    <h1 id="welcome-heading">{$i18n.t('home.welcome')}</h1>
    <p class="description">{$i18n.t('home.empty')}</p>

    <div class="actions">
      <a class="action action-primary" href={resolve('/direct')}>{$i18n.t('nav.direct')}</a>
      <a class="action action-secondary" href={resolve('/explore')}>{$i18n.t('nav.explore')}</a>
    </div>
  </div>
</section>

<style>
  .empty-state {
    align-items: center;
    display: flex;
    min-height: 100%;
    padding: 2rem 1.25rem;
  }

  .empty-state-content {
    margin: 0 auto;
    max-width: 28rem;
    text-align: center;
    width: 100%;
  }

  .eyebrow {
    color: var(--sable-primary-main);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.08em;
    margin: 0 0 0.5rem;
    text-transform: uppercase;
  }

  h1 {
    font-size: clamp(2rem, 8vw, 2.5rem);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .description {
    color: var(--sable-surface-var-on-container);
    margin: 1rem 0 0;
  }

  .actions {
    display: grid;
    gap: 0.75rem;
    margin-top: 2rem;
  }

  .action {
    align-items: center;
    border: 1px solid transparent;
    border-radius: var(--radius);
    display: flex;
    font-weight: var(--font-weight-medium);
    justify-content: center;
    min-height: 2.75rem;
    padding: 0.5rem 1rem;
    text-decoration: none;
  }

  .action:focus-visible {
    outline: 3px solid var(--sable-focus-ring);
    outline-offset: 2px;
  }

  .action-primary {
    background: var(--sable-primary-container);
    border-color: var(--sable-primary-container-line);
    color: var(--sable-primary-on-container);
  }

  .action-primary:hover {
    background: var(--sable-primary-container-hover);
  }

  .action-secondary {
    border-color: var(--sable-bg-container-line);
    color: var(--sable-bg-on-container);
  }

  .action-secondary:hover {
    background: var(--sable-bg-container-hover);
  }

  @media (prefers-reduced-motion: no-preference) {
    .action {
      transition:
        background-color var(--motion-normal) ease,
        border-color var(--motion-normal) ease;
    }
  }

  @media (width >= 32rem) {
    .actions {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
