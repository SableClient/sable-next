<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import CallView from './CallView.svelte';
  import type { CallSession } from './call-session.svelte';
  import type { MemberView } from '#src/generated/protocol';
  import { idleTransportState } from './call-transport';

  const track = { id: 'camera', muted: false, subscribed: true };

  const session: CallSession = {
    toggleMicrophone: () => {},
    lifecycle: 'active',
    mediaReady: true,
    failure: null,
    deviceError: null,
    startedAt: null,
    layout: { pinned: null, gridForced: false },
    watchedScreenShareIds: [],
    views: 0,
    deafened: false,
    microphoneEnabled: true,
    inputMode: 'voice-activity',
    encryptsMedia: false,
    canScreenShare: true,
    canSwitchCamera: true,
    audioRoutes: { list: () => Promise.resolve([]), select: () => Promise.resolve() },
    localVideo: undefined,
    remoteVideo: undefined,
    rooms: [],
    members: [],
    transport: {
      ...idleTransportState(),
      connection: 'connected',
      microphoneEnabled: true,
      self: { identity: '@me:matrix.org', local: true },
      participants: [{ identity: '@alice:matrix.org', camera: undefined, microphone: track }],
    },
    roomFor: () => undefined,
  } as unknown as CallSession;
  const members: MemberView[] = [
    {
      user_id: '@me:matrix.org',
      display_name: 'Me',
      power_level: 100,
      kicked: false,
      service: false,
    } as unknown as MemberView,
    {
      user_id: '@alice:matrix.org',
      display_name: 'Alice',
      power_level: 100,
      kicked: false,
      service: false,
    } as unknown as MemberView,
  ];

  const { Story } = defineMeta({
    title: 'Room/Call View',
    tags: ['autodocs'],
  });
</script>

<Story name="Default">
  <CallView {session} {members} />
</Story>

<Story name="Many members">
  <CallView
    session={{
      ...session,
      transport: {
        ...idleTransportState(),
        connection: 'connected',
        microphoneEnabled: true,
        self: { identity: '@me:matrix.org', local: true },
        participants: [
          { identity: '@alice:matrix.org', camera: undefined, microphone: track },
          { identity: '@bob:matrix.org', camera: undefined, microphone: track },
          { identity: '@mallory:matrix.org', camera: undefined, microphone: track },
          { identity: '@kris:matrix.org', camera: undefined, microphone: track },
        ],
      },
    } as unknown as CallSession}
    members={[
      ...members,
      {
        user_id: '@bob:matrix.org',
        display_name: 'Bob',
        power_level: 100,
        kicked: false,
        service: false,
      } as unknown as MemberView,
      {
        user_id: '@mallory:matrix.org',
        display_name: 'Mallory',
        power_level: 100,
        kicked: false,
        service: false,
      } as unknown as MemberView,
      {
        user_id: '@kris:matrix.org',
        display_name: 'Kris',
        power_level: 100,
        kicked: false,
        service: false,
      } as unknown as MemberView,
    ] as unknown as MemberView[]}
  />
</Story>

<Story name="Muted & Deafened">
  <CallView
    session={{ ...session, microphoneEnabled: false, deafened: true } as unknown as CallSession}
    {members}
  />
</Story>
<Story name="Media not ready">
  <CallView session={{ ...session, mediaReady: false } as unknown as CallSession} {members} />
</Story>

<style>
  :global(.stage.resting) {
    height: 20rem;
  }

  :global(.stage) {
    height: 20rem;
  }
</style>
