<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  const { Story } = defineMeta({
    title: 'Design tokens',
    tags: ['autodocs'],
  });

  const scale = (prefix: string, steps: string[]) =>
    steps.map((step) => ({ step, token: `${prefix}-${step}` }));

  const space = scale('--space', ['100', '200', '300', '400', '500', '600', '700']);
  const radii = scale('--radii', ['300', '400', '500', 'pill']);
  const sizes = scale('--size', ['x50', 'x100', 'x200', 'x300', 'x400', 'x500', 'x600']);
  const borders = scale('--border-width', ['300', '400', '500', '600', '700']);
  const shadows = scale('--shadow', ['e100', 'e200', 'e300', 'e400']);
  const type = [
    'd400',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    't500',
    't400',
    't300',
    't200',
    'b500',
    'b400',
    'b300',
    'l400',
  ].map((step) => ({
    step,
    size: `--font-size-${step}`,
    lineHeight: `--line-height-${step}`,
  }));

  const containerSteps = ['container', 'container-hover', 'container-active', 'container-line'];
  const mainSteps = ['main', 'main-hover', 'main-active', 'main-line'];
  const swatches = (family: string, steps: string[]) => ({
    family,
    steps: steps.map((step) => ({ step, token: `--sable-${family}-${step}` })),
  });

  const families = [
    'bg',
    'surface',
    'surface-var',
    'primary',
    'sec',
    'success',
    'warn',
    'crit',
  ].map((family) => ({
    ...swatches(family, containerSteps),
    base: `--sable-${family}-container`,
    on: `--sable-${family}-on-container`,
  }));
  const mainFamilies = ['primary', 'sec', 'success', 'warn', 'crit'].map((family) => ({
    ...swatches(family, mainSteps),
    base: `--sable-${family}-main`,
    on: `--sable-${family}-on-main`,
  }));
</script>

<Story name="Spacing" asChild>
  <div class="stack">
    {#each space as { step, token } (step)}
      <div class="measure">
        <code>{token}</code>
        <span class="bar" style="width: var({token})"></span>
      </div>
    {/each}
  </div>
</Story>

<Story name="Radii" asChild>
  <div class="row">
    {#each radii as { step, token } (step)}
      <div class="swatch">
        <span class="tile" style="border-radius: var({token})"></span>
        <code>{token}</code>
      </div>
    {/each}
  </div>
</Story>

<Story name="Cross sizes" asChild>
  <div class="row">
    {#each sizes as { step, token } (step)}
      <div class="swatch">
        <span class="tile" style="height: var({token}); width: var({token})"></span>
        <code>{token}</code>
      </div>
    {/each}
  </div>
</Story>

<Story name="Border widths" asChild>
  <div class="stack">
    {#each borders as { step, token } (step)}
      <div class="measure">
        <code>{token}</code>
        <span class="rule" style="border-bottom-width: var({token})"></span>
      </div>
    {/each}
  </div>
</Story>

<Story name="Elevation" asChild>
  <div class="row">
    {#each shadows as { step, token } (step)}
      <div class="swatch">
        <span class="card" style="box-shadow: var({token})"></span>
        <code>{token}</code>
      </div>
    {/each}
  </div>
</Story>

<Story name="Type ramp" asChild>
  <div class="stack">
    {#each type as { step, size, lineHeight } (step)}
      <p class="specimen" style="font-size: var({size}); line-height: var({lineHeight})">
        <code>{step}</code>
        The quick brown fox
      </p>
    {/each}
  </div>
</Story>

<Story name="Colour: containers" asChild>
  <table>
    <thead>
      <tr>
        <th scope="col">Family</th>
        {#each containerSteps as step (step)}<th scope="col">{step}</th>{/each}
        <th scope="col">on-container</th>
      </tr>
    </thead>
    <tbody>
      {#each families as { family, steps, base, on } (family)}
        <tr>
          <th scope="row"><code>{family}</code></th>
          {#each steps as { step, token } (step)}
            <td><span class="chip" style="background: var({token})"></span></td>
          {/each}
          <td>
            <span class="chip text" style="background: var({base}); color: var({on})">Aa</span>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</Story>

<Story name="Colour: mains" asChild>
  <table>
    <thead>
      <tr>
        <th scope="col">Family</th>
        {#each mainSteps as step (step)}<th scope="col">{step}</th>{/each}
        <th scope="col">on-main</th>
      </tr>
    </thead>
    <tbody>
      {#each mainFamilies as { family, steps, base, on } (family)}
        <tr>
          <th scope="row"><code>{family}</code></th>
          {#each steps as { step, token } (step)}
            <td><span class="chip" style="background: var({token})"></span></td>
          {/each}
          <td>
            <span class="chip text" style="background: var({base}); color: var({on})">Aa</span>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</Story>

<style>
  .stack {
    display: grid;
    gap: var(--space-300);
  }

  .row {
    align-items: flex-end;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-500);
  }

  .measure {
    align-items: center;
    display: grid;
    gap: var(--space-300);
    grid-template-columns: 12rem 1fr;
  }

  .swatch {
    display: grid;
    gap: var(--space-200);
    justify-items: center;
  }

  .bar {
    background: var(--sable-primary-main);
    display: block;
    height: var(--space-300);
  }

  .rule {
    border-bottom-color: var(--sable-bg-container-line);
    border-bottom-style: solid;
    display: block;
  }

  .tile {
    background: var(--sable-primary-container);
    display: block;
    height: var(--size-x600);
    outline: var(--border-width) solid var(--sable-primary-container-line);
    width: var(--size-x600);
  }

  .card {
    background: var(--sable-surface-container);
    border-radius: var(--radii-400);
    display: block;
    height: var(--space-700);
    width: 5rem;
  }

  .specimen {
    margin: 0;
  }

  .specimen code {
    color: var(--sable-sec-main);
    display: inline-block;
    font-size: var(--font-size-t200);
    width: 4rem;
  }

  table {
    border-collapse: collapse;
    font-size: var(--font-size-t200);
  }

  th,
  td {
    padding: var(--space-100);
    text-align: left;
  }

  .chip {
    border-radius: var(--radii-300);
    display: grid;
    height: var(--size-x600);
    outline: var(--border-width) solid var(--sable-bg-container-line);
    place-items: center;
    width: 4rem;
  }

  .chip.text {
    font-weight: var(--font-weight-600);
  }
</style>
