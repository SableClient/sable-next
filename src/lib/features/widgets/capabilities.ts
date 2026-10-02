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
  'org.matrix.msc2931.navigate': 'widgets.capabilityNavigate',
  'town.robin.msc3846.turn_servers': 'widgets.capabilityTurnServers',
  'org.matrix.msc3973.user_directory_search': 'widgets.capabilityUserDirectory',
  'org.matrix.msc4039.upload_file': 'widgets.capabilityUploadFile',
  'org.matrix.msc4039.download_file': 'widgets.capabilityDownloadFile',
  'org.matrix.msc4157.send.delayed_event': 'widgets.capabilityDelayedSend',
  'org.matrix.msc4157.update_delayed_event': 'widgets.capabilityDelayedUpdate',
  'org.matrix.msc4407.send.sticky_event': 'widgets.capabilityStickySend',
  'org.matrix.msc4407.receive.sticky_event': 'widgets.capabilityStickyReceive',
  'org.matrix.msc4515.rtc_transports': 'widgets.capabilityRtcTransports',
  'org.matrix.msc4533.rtc_livekit_get_token': 'widgets.capabilityLivekitToken',
  'org.matrix.msc4533.rtc_livekit_delegate_delayed_leave': 'widgets.capabilityLivekitLeave',
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
