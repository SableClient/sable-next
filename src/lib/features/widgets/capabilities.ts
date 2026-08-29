const OPENID = 'm.allow_openid';
const SENSITIVE = new Set([OPENID, 'm.always_on_screen']);
const SENSITIVE_PREFIX = 'org.matrix.msc3819.send.to_device:';

export function isSensitiveCapability(capability: string): boolean {
  return SENSITIVE.has(capability) || capability.startsWith(SENSITIVE_PREFIX);
}

const LABELS: Partial<Record<string, string>> = {
  [OPENID]: 'widgets.capabilityOpenId',
  'm.always_on_screen': 'widgets.capabilityAlwaysOnScreen',
  'm.sticker': 'widgets.capabilitySticker',
};

export function capabilityLabel(capability: string): string {
  const known = LABELS[capability];
  if (known !== undefined) return known;

  if (capability.startsWith('org.matrix.msc2762.send.state_event:')) {
    return 'widgets.capabilitySendState';
  }
  if (capability.startsWith('org.matrix.msc2762.send.event:')) return 'widgets.capabilitySend';
  if (capability.startsWith('org.matrix.msc2762.receive.state_event:')) {
    return 'widgets.capabilityReceiveState';
  }
  if (capability.startsWith('org.matrix.msc2762.receive.event:')) {
    return 'widgets.capabilityReceive';
  }
  if (capability.startsWith('org.matrix.msc3819.send.to_device:')) {
    return 'widgets.capabilitySendToDevice';
  }
  if (capability.startsWith('org.matrix.msc3819.receive.to_device:')) {
    return 'widgets.capabilityReceiveToDevice';
  }

  return 'widgets.capabilityOther';
}
