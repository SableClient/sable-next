<script lang="ts" module>
  const titles: { title: string }[] = [];
  let previousTitle = '';
</script>

<script lang="ts">
  import { pageTitle } from '#lib/deployment/brand.js';

  let { title }: { title: string } = $props();
  const entry = { title: '' };

  $effect.pre(() => {
    if (titles.length === 0) previousTitle = document.title;
    titles.push(entry);

    return () => {
      const current = titles.at(-1) === entry;
      titles.splice(titles.indexOf(entry), 1);
      if (current) document.title = titles.at(-1)?.title ?? previousTitle;
    };
  });

  $effect.pre(() => {
    entry.title = pageTitle(title);
    if (titles.at(-1) === entry) document.title = entry.title;
  });
</script>
