import type {
  CallBackendView,
  CallIntent,
  CallMode,
  Rpc,
  RpcResult,
} from '#src/generated/protocol';

export type CallGrant = RpcResult<Rpc['calls']['join']>;

export type CallBackendGrant = CallBackendView;

export async function joinCall(
  rpc: Rpc,
  roomId: string,
  livekitServiceUrl: string | null = null,
  mode: CallMode | null = null,
  intent: CallIntent | null = null
): Promise<CallGrant> {
  const response = await rpc.calls.join({
    room_id: roomId,
    livekit_service_url: livekitServiceUrl,
    mode: mode ?? null,
    intent,
  });
  return response;
}
