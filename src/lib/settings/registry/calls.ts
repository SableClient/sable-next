import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
import MonitorIcon from 'phosphor-svelte/lib/MonitorIcon';
import NetworkIcon from 'phosphor-svelte/lib/NetworkIcon';
import PhoneIcon from 'phosphor-svelte/lib/PhoneIcon';
import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
import { hasNativeCalls } from '#lib/platform/calls.js';
import { isElectron } from '#lib/platform/electron.js';
import {
  CALL_SCREEN_FRAMERATES,
  CALL_VIDEO_BITRATES,
  CALL_VIDEO_CODECS,
  CALL_VIDEO_RESOLUTIONS,
} from '../definitions';
import type { SettingOption, SettingsCategory } from '../registry';

const callResolutionOptions: SettingOption[] = CALL_VIDEO_RESOLUTIONS.map((value) =>
  value === 'auto'
    ? { value, label: 'settings.callVideoAutomatic' }
    : { value, label: `${value}p`, literal: true }
);
const callBitrateOptions: SettingOption[] = CALL_VIDEO_BITRATES.map((value) =>
  value === 'auto'
    ? { value, label: 'settings.callVideoAutomatic' }
    : { value, label: `${value} kbps`, literal: true }
);
const callFramerateOptions: SettingOption[] = CALL_SCREEN_FRAMERATES.map((value) =>
  value === 'auto'
    ? { value, label: 'settings.callVideoAutomatic' }
    : { value, label: `${value} fps`, literal: true }
);
const callCodecOptions: SettingOption[] = CALL_VIDEO_CODECS.map((value) =>
  value === 'auto'
    ? { value, label: 'settings.callVideoAutomatic' }
    : { value, label: value === 'h264' ? 'H.264' : value.toUpperCase(), literal: true }
);

export const callsCategory: SettingsCategory = {
  id: 'calls',
  name: 'settings.callsTitle',
  icon: PhoneIcon,
  sections: [
    { id: 'call-devices', name: 'settings.callDevicesTitle' },
    { id: 'microphone', name: 'settings.groups.microphone' },
    { id: 'call-camera', name: 'settings.callCameraQuality' },
    { id: 'ringing', name: 'settings.groups.ringing' },
    { id: 'call-button', name: 'settings.groups.callButton' },
    { id: 'call-screens', name: 'settings.groups.callScreens' },
    { id: 'call-service', name: 'settings.callServiceTitle' },
    { id: 'call-compat', name: 'settings.groups.callCompat' },
  ],
  items: [
    {
      key: 'callInputMode',
      section: 'microphone',
      icon: MicrophoneIcon,
      name: 'settings.callInputMode',
      description: 'settings.callInputModeHint',
      supported: () => !hasNativeCalls(),
      type: 'select',
      options: [
        { value: 'voice-activity', label: 'settings.callInputVoiceActivity' },
        { value: 'push-to-talk', label: 'settings.callInputPushToTalk' },
      ],
    },
    {
      key: 'callGlobalShortcuts',
      section: 'microphone',
      icon: MicrophoneIcon,
      name: 'settings.callGlobalShortcuts',
      description: 'settings.callGlobalShortcutsHint',
      type: 'boolean',
      supported: isElectron,
    },
    {
      key: 'callCameraResolution',
      section: 'call-camera',
      icon: MonitorIcon,
      name: 'settings.callCameraResolution',
      type: 'select',
      options: callResolutionOptions,
      supported: () => !hasNativeCalls(),
    },
    {
      key: 'callCameraBitrate',
      section: 'call-camera',
      icon: MonitorIcon,
      name: 'settings.callCameraBitrate',
      type: 'select',
      options: callBitrateOptions,
      supported: () => !hasNativeCalls(),
    },
    {
      key: 'callCameraCodec',
      section: 'call-camera',
      icon: MonitorIcon,
      name: 'settings.callCameraCodec',
      type: 'select',
      options: callCodecOptions,
      supported: () => !hasNativeCalls(),
    },
    {
      key: 'callScreenResolution',
      section: 'call-screens',
      icon: MonitorIcon,
      name: 'settings.callScreenResolution',
      type: 'select',
      options: callResolutionOptions,
      supported: () => !hasNativeCalls(),
    },
    {
      key: 'callScreenBitrate',
      section: 'call-screens',
      icon: MonitorIcon,
      name: 'settings.callScreenBitrate',
      type: 'select',
      options: callBitrateOptions,
      supported: () => !hasNativeCalls(),
    },
    {
      key: 'callScreenFramerate',
      section: 'call-screens',
      icon: MonitorIcon,
      name: 'settings.callScreenFramerate',
      type: 'select',
      options: callFramerateOptions,
      supported: () => !hasNativeCalls(),
    },
    {
      key: 'callScreenCodec',
      section: 'call-screens',
      icon: MonitorIcon,
      name: 'settings.callScreenCodec',
      type: 'select',
      options: callCodecOptions,
      supported: () => !hasNativeCalls(),
    },
    {
      key: 'callSimulcast',
      section: 'call-camera',
      icon: MonitorIcon,
      name: 'settings.callSimulcast',
      description: 'settings.callSimulcastHint',
      type: 'boolean',
      supported: () => !hasNativeCalls(),
    },
    {
      key: 'noiseSuppression',
      section: 'microphone',
      icon: MicrophoneIcon,
      name: 'settings.noiseSuppression',
      terms: ['settings.terms.noiseSuppression'],
      type: 'boolean',
    },
    {
      key: 'voiceIsolation',
      section: 'microphone',
      icon: MicrophoneIcon,
      name: 'settings.voiceIsolation',
      description: 'settings.voiceIsolationHint',
      type: 'boolean',
      gatedBy: 'noiseSuppression',
    },
    {
      key: 'incomingVoiceIsolation',
      section: 'microphone',
      icon: SpeakerHighIcon,
      name: 'settings.incomingVoiceIsolation',
      description: 'settings.incomingVoiceIsolationHint',
      type: 'boolean',
      supported: () => !hasNativeCalls(),
    },
    {
      key: 'echoCancellation',
      section: 'microphone',
      icon: MicrophoneIcon,
      name: 'settings.echoCancellation',
      type: 'boolean',
    },
    {
      key: 'autoGainControl',
      section: 'microphone',
      icon: MicrophoneIcon,
      name: 'settings.autoGainControl',
      type: 'boolean',
    },
    {
      key: 'incomingCallSound',
      section: 'ringing',
      icon: PhoneIcon,
      name: 'settings.incomingCallSound',
      type: 'boolean',
    },
    {
      key: 'outgoingRingback',
      section: 'ringing',
      icon: PhoneIcon,
      name: 'settings.outgoingRingback',
      type: 'boolean',
    },
    {
      key: 'ringForGroupCalls',
      section: 'ringing',
      icon: PhoneIcon,
      name: 'settings.ringForGroupCalls',
      type: 'boolean',
    },
    {
      key: 'alwaysShowCallButton',
      section: 'call-button',
      icon: PhoneIcon,
      name: 'settings.alwaysShowCallButton',
      type: 'boolean',
    },
    {
      key: 'callScreenPreview',
      section: 'call-screens',
      icon: MonitorIcon,
      name: 'settings.callScreenPreview',
      type: 'boolean',
    },
    {
      key: 'callMode',
      section: 'call-compat',
      icon: PhoneIcon,
      name: 'settings.callMode',
      description: 'settings.callModeHint',
      type: 'select',
      options: [
        { value: 'auto', label: 'settings.callModeAuto' },
        { value: 'legacy', label: 'settings.callModeLegacy' },
        { value: 'compatibility', label: 'settings.callModeCompatibility' },
        { value: 'matrix_2', label: 'settings.callModeMatrix2' },
      ],
    },
    {
      key: 'webRtcIpPolicy',
      section: 'call-compat',
      icon: NetworkIcon,
      name: 'settings.webRtcIpPolicy',
      description: 'settings.webRtcIpPolicyHint',
      type: 'select',
      options: [
        { value: 'default', label: 'settings.webRtcIpPolicyDefault' },
        {
          value: 'default_public_and_private_interfaces',
          label: 'settings.webRtcIpPolicyPrivate',
        },
        { value: 'default_public_interface_only', label: 'settings.webRtcIpPolicyPublic' },
        { value: 'disable_non_proxied_udp', label: 'settings.webRtcIpPolicyProxied' },
      ],
      supported: isElectron,
    },
  ],
};
