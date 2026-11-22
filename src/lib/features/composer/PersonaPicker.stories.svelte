<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import PersonaPicker from './PersonaPicker.svelte';
  import PersonaMenu from './PersonaMenu.svelte';
  import { testPersona } from '#lib/personas/persona.ts';

  const fakePersona = (display_name: string) => {
    return {
      ...testPersona,
      id: crypto.randomUUID(),
      display_name,
    };
  };
  const personas = [testPersona, fakePersona('Alice'), fakePersona('Bob'), fakePersona('Mallory')];

  const { Story } = defineMeta({
    title: 'Composer/Persona Picker',
    tags: ['autodocs'],
  });
</script>

<!--
AKA the Per-Message Profile picker.
-->
<Story name="Default">
  <PersonaPicker roomId="!foo" />
</Story>

<Story name="Menu">
  <PersonaMenu
    {personas}
    selected={{
      persona_id: 'kris',
      alternate_avatar_id: null,
      valid_until: null,
    }}
    scope="account"
    onChoose={() => {}}
    onScope={() => {}}
    onAlternateAvatarChoose={() => {}}
  />
</Story>

<Story name="Alternate Avatar selection">
  <PersonaMenu
    {personas}
    selected={{
      persona_id: 'kris',
      alternate_avatar_id: '1',
      valid_until: null,
    }}
    scope="account"
    onChoose={() => {}}
    onScope={() => {}}
    onAlternateAvatarChoose={() => {}}
  />
</Story>

<Story name="Scope selection enabled">
  <PersonaMenu
    personas={[testPersona, fakePersona('Alice'), fakePersona('Bob'), fakePersona('Mallory')]}
    selected={{
      persona_id: 'kris',
      alternate_avatar_id: null,
      valid_until: null,
    }}
    scopeChoice={true}
    scope="account"
    onChoose={() => {}}
    onScope={() => {}}
    onAlternateAvatarChoose={() => {}}
  />
</Story>

<Story name="Account provided">
  <PersonaMenu
    personas={[testPersona, fakePersona('Alice'), fakePersona('Bob'), fakePersona('Mallory')]}
    selected={{
      persona_id: 'kris',
      alternate_avatar_id: null,
      valid_until: null,
    }}
    scopeChoice={true}
    scope="account"
    account={{ id: '@alice:matrix.org', name: 'Alice', avatarUrl: 'mxc://example.png' }}
    onChoose={() => {}}
    onScope={() => {}}
    onAlternateAvatarChoose={() => {}}
  />
</Story>

<!--
Adds more margin
-->
<Story name="Sheet variant">
  <PersonaMenu
    personas={[testPersona, fakePersona('Alice'), fakePersona('Bob'), fakePersona('Mallory')]}
    selected={{
      persona_id: 'kris',
      alternate_avatar_id: null,
      valid_until: null,
    }}
    variant="sheet"
    scope="account"
    onChoose={() => {}}
    onScope={() => {}}
    onAlternateAvatarChoose={() => {}}
  />
</Story>
