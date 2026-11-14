<script lang="ts">
  import { type GestureTarget, cropGestures } from './crop-gestures';

  let { gestures }: { gestures: GestureTarget } = $props();
</script>

<div
  class="stage"
  style="height: 300px; left: 100px; position: fixed; top: 50px; width: 400px;"
  {@attach cropGestures(gestures)}
>
  <span class="handle" data-corner="se"></span>
</div>
