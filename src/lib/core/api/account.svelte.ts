import type { ProfileOverridesView, Rpc, RpcParams } from '#src/generated/protocol';

type ProfileOverrideEdit = Omit<RpcParams<Rpc['account']['setProfileOverride']>, 'user_id'>;

export async function setAccountData(rpc: Rpc, eventType: string, content: unknown): Promise<void> {
  await rpc.account.setData({ event_type: eventType, content: $state.snapshot(content) });
}

export async function setSealedAccountData(
  rpc: Rpc,
  eventType: string,
  content: unknown
): Promise<void> {
  await rpc.account.setSealedData({
    event_type: eventType,
    content: $state.snapshot(content),
  });
}

export function setProfileOverride(
  rpc: Rpc,
  userId: string,
  edit: ProfileOverrideEdit
): Promise<ProfileOverridesView> {
  return rpc.account.setProfileOverride({ user_id: userId, ...$state.snapshot(edit) });
}
