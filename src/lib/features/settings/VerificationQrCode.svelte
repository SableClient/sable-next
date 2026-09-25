<script lang="ts">
  import logo from '#lib/assets/res/svg/logo.svg';

  import type { QrCodeView } from '#src/generated/protocol';

  import { qrLayout } from './verification-qr';

  interface Props {
    code: QrCodeView;
    label: string;
  }

  let { code, label }: Props = $props();

  const layout = $derived(qrLayout(code));
  const path = $derived(layout.dark.map(([x, y]) => `M${String(x)} ${String(y)}h1v1h-1z`).join(''));
</script>

<svg
  class="verification-qr"
  viewBox={`0 0 ${String(layout.size)} ${String(layout.size)}`}
  role="img"
  aria-label={label}
  shape-rendering="crispEdges"
>
  <rect class="verification-qr-light" width={layout.size} height={layout.size} />
  <path class="verification-qr-dark" d={path} />
  <circle
    class="verification-qr-light"
    cx={layout.plate.centre}
    cy={layout.plate.centre}
    r={layout.plate.radius}
  />
  <image
    href={logo}
    x={layout.logo.start}
    y={layout.logo.start}
    width={layout.logo.size}
    height={layout.logo.size}
  />
</svg>

<style>
  .verification-qr {
    border-radius: var(--radii-400);
    display: block;
    height: auto;
    max-width: 100%;
    width: 16rem;
  }

  .verification-qr-light {
    fill: var(--qr-light);
  }

  .verification-qr-dark {
    fill: var(--qr-dark);
  }
</style>
