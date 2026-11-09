<script lang="ts">
  import { preferences } from '#lib/settings/preferences.svelte.ts';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Slider from '#lib/ui/primitives/Slider.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import { zooAlertState } from './ZooAlert.svelte';
</script>

<div class="zoo-controls">
  <div class="heyguys">
    <b>◈ test alert settings</b>
  </div>
  <div>
    Show alert
    <Switch label="" bind:checked={zooAlertState.visible} />
  </div>
  <div>
    Level
    <Select
      bind:value={zooAlertState.level}
      items={[
        { label: 'update', value: 'update' },
        { label: 'warning', value: 'warning' },
        { label: 'task', value: 'task' },
        { label: 'security', value: 'security' },
        { label: 'critical', value: 'critical' },
      ]}
    />
  </div>
  <div>
    Show progress
    <Switch
      label=""
      checked={zooAlertState.progress !== undefined}
      onCheckedChange={(checked) => {
        zooAlertState.progress = checked ? { value: null } : undefined;
      }}
    />
  </div>
  <div>
    Indeterminate progress
    <Switch
      label=""
      disabled={zooAlertState.progress === undefined}
      checked={zooAlertState.progress && zooAlertState.progress.value === null}
      onCheckedChange={(checked) => {
        if (zooAlertState.progress) {
          zooAlertState.progress = { value: checked ? null : 0 };
        }
      }}
    />
  </div>
  <div>
    Progress value
    <Slider
      label=""
      disabled={zooAlertState.progress === undefined}
      min={0}
      max={100}
      value={(zooAlertState.progress?.value ?? 0) * 100}
      oninput={(value) => {
        if (zooAlertState.progress && (zooAlertState.progress.value !== null || value != 0)) {
          zooAlertState.progress.value = value / 100;
        }
      }}
    />
  </div>
  <div>
    <Button
      variant="danger"
      size="small"
      onclick={() => {
        preferences.showAlertZoo = false;
      }}>hide da settings</Button
    >
  </div>
</div>

<style>
  .zoo-controls {
    background: var(--bg-container);
    border: var(--border-width) solid var(--crit-main);
    border-bottom-left-radius: var(--radius);
    border-right: none;
    border-top-left-radius: var(--radius);
    padding: var(--space-200);
    position: fixed;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
  }

  .heyguys {
    margin-bottom: var(--space-200);
  }
</style>
