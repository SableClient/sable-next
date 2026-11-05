<script lang="ts">
  import { untrack } from 'svelte';
  import type { CoreClient } from '#lib/core/client.svelte.js';
  import { provideCoreClient } from '#lib/core/context.js';
  import ProfileCard from '#lib/ui/primitives/ProfileCard.svelte';
  import { bioContent } from './bio-content.js';
  import BioEditor from './BioEditor.svelte';
  import './profile-editor.css';

  let { core, html = '' }: { core: CoreClient; html?: string } = $props();
  provideCoreClient(untrack(() => core));
  let value = $state(untrack(() => bioContent(html)));
</script>

<div class="profile-section">
  <div class="profile-hero">
    <ProfileCard userId="@me:example.org" displayName="Me" color="#7360c0">
      <div class="caption-field">
        <label for="test-bio">Biography</label>
        <BioEditor id="test-bio" bind:value />
      </div>
    </ProfileCard>
  </div>
</div>
<output>{JSON.stringify(value)}</output>
<button
  type="button"
  onclick={() => {
    value = bioContent(html);
  }}>Reset</button
>
