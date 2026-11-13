import type { CoreClient } from '#lib/core/client.svelte.js';
import { sendMessage } from '#lib/core/api/messages.svelte.js';
import { buildInvocation } from '#lib/model/model.js';

import type { PolicyAction } from './meowlnir-policies.js';

const ADD_COMMANDS: Record<PolicyAction, string> = {
  ban: 'ban',
  takedown: 'takedown',
  unban: 'add-unban',
  mute: 'mute',
};

/**
 * Meowlnir answers in the room, so this resolves once the command is sent,
 * not once it is carried out. Bots that describe their commands get the
 * structured form, which survives odd characters in the arguments.
 */
export async function sendMeowlnirCommand(
  core: CoreClient,
  managementRoomId: string,
  name: string,
  args: Record<string, string>
): Promise<void> {
  const commands = await core.rpc.room_state
    .botCommands({ room_id: managementRoomId })
    .catch(() => []);
  const described = commands.find((command) => command.command === name);
  const built = described ? buildInvocation(described, args, '!') : null;
  if (described && built?.kind === 'built') {
    await sendMessage(core.rpc, managementRoomId, built.body, {
      mentions: [described.sender],
      bot_command: built.invocation,
    });
    return;
  }
  const words = Object.values(args).filter((value) => value !== '');
  await sendMessage(core.rpc, managementRoomId, [`!${name}`, ...words].join(' '));
}

/** `args` order is the order Meowlnir reads them in, the reason last as it takes the rest. */
export function addPolicy(
  core: CoreClient,
  managementRoomId: string,
  action: PolicyAction,
  list: string,
  entity: string,
  reason: string
): Promise<void> {
  return sendMeowlnirCommand(core, managementRoomId, ADD_COMMANDS[action], {
    list,
    entity,
    reason,
  });
}

export function removePolicy(
  core: CoreClient,
  managementRoomId: string,
  list: string,
  entity: string
): Promise<void> {
  return sendMeowlnirCommand(core, managementRoomId, 'remove-policy', { list, entity });
}
