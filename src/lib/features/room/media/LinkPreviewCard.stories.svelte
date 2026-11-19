<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import LinkPreviewCard from './LinkPreviewCard.svelte';

  export const TaskData = {
    url: "https://f0rest.net",
    encrypted: false,
    bundled: {
      url: "https://f0rest.net",
      title: "F0rest.net",
      description: "hello world"
    }
  };
  
  const { Story } = defineMeta({
    title: 'Timeline/LinkPreviewCard',
    component: LinkPreviewCard,
    tags: ['autodocs'],
    args: {...TaskData},
    // argTypes: { variant: { control: 'select', options: variants } },
    // args: { label: 'Verified', variant: 'neutral' },
  });

</script>

<Story name="Default" args={{ ...TaskData }} />
