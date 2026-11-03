// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import type { KeywordNotificationView, MentionNotificationModeView } from '#src/generated/protocol';
import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = baseCore;
Object.assign(core.rpc.notifications, {
  keywords: vi.fn<() => Promise<KeywordNotificationView[]>>(),
  addKeyword: vi.fn<(params: { keyword: string }) => Promise<void>>(),
  removeKeyword: vi.fn<(params: { keyword: string }) => Promise<void>>(),
  setKeywordMode:
    vi.fn<(params: { keyword: string; mode: MentionNotificationModeView }) => Promise<void>>(),
});
Object.assign(core.rpc.notifications, core);

function listed(...keywords: string[]): KeywordNotificationView[] {
  return keywords.map((keyword) => ({ keyword, mode: 'notify' }));
}

import NotificationKeywords from './NotificationKeywords.svelte';

afterEach(() => {
  vi.clearAllMocks();
});

const keywords = () =>
  screen
    .queryAllByRole('listitem')
    .map((item) => item.querySelector('.settings-item-text')?.textContent);
const input = () => screen.getByRole('textbox', { name: 'Add a keyword' });

async function confirmRemoval(user: ReturnType<typeof userEvent.setup>, keyword: string) {
  await user.click(screen.getByRole('button', { name: `Remove keyword ${keyword}` }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent(`Remove keyword ${keyword}?`);
  return () => user.click(within(dialog).getByRole('button', { name: 'Remove' }));
}

test('lists the account keywords and lets one be removed', async () => {
  const user = userEvent.setup();
  core.rpc.notifications.keywords.mockResolvedValueOnce(listed('kris', 'sable'));
  core.rpc.notifications.keywords.mockResolvedValueOnce(listed('sable'));
  core.rpc.notifications.removeKeyword.mockResolvedValue(null);

  render(NotificationKeywords);
  await vi.waitFor(() => {
    expect(keywords()).toEqual(['kris', 'sable']);
  });

  const confirm = await confirmRemoval(user, 'kris');
  expect(core.rpc.notifications.removeKeyword).not.toHaveBeenCalled();
  await confirm();

  await vi.waitFor(() => {
    expect(core.rpc.notifications.removeKeyword).toHaveBeenCalledWith({ keyword: 'kris' });
    expect(keywords()).toEqual(['sable']);
  });
});

test('refuses a blank or whitespace-only keyword', async () => {
  const user = userEvent.setup();
  core.rpc.notifications.keywords.mockResolvedValue([]);

  render(NotificationKeywords);
  await vi.waitFor(() => {
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  await user.type(input(), '   {Enter}');

  expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  expect(core.rpc.notifications.addKeyword).not.toHaveBeenCalled();
});

test('does not add a keyword already in the list', async () => {
  const user = userEvent.setup();
  core.rpc.notifications.keywords.mockResolvedValue(listed('sable'));

  render(NotificationKeywords);
  await vi.waitFor(() => {
    expect(keywords()).toEqual(['sable']);
  });

  await user.type(input(), 'sable{Enter}');

  expect(core.rpc.notifications.addKeyword).not.toHaveBeenCalled();
});

test('deduplicates an inconsistent keyword response before rendering', async () => {
  core.rpc.notifications.keywords.mockResolvedValue([
    { keyword: 'sable', mode: 'notify' },
    { keyword: 'sable', mode: 'loud' },
  ]);

  render(NotificationKeywords);

  expect(await screen.findAllByText('sable')).toHaveLength(1);
});

test('does not leave the list showing an add the server rejected', async () => {
  const user = userEvent.setup();
  core.rpc.notifications.keywords.mockResolvedValue(listed('sable'));
  core.rpc.notifications.addKeyword.mockRejectedValue(new Error('denied'));

  render(NotificationKeywords);
  await vi.waitFor(() => {
    expect(keywords()).toEqual(['sable']);
  });

  await user.type(input(), 'kris{Enter}');

  expect(await screen.findByRole('status')).toHaveTextContent('That keyword could not be added.');
  expect(keywords()).toEqual(['sable']);
  expect(core.rpc.notifications.keywords).toHaveBeenCalledTimes(1);
});

test('reports a load failure instead of showing an empty list', async () => {
  core.rpc.notifications.keywords.mockRejectedValue(new Error('denied'));

  render(NotificationKeywords);
  expect(await screen.findByText('Your keywords could not be loaded.')).toBeInTheDocument();
  expect(screen.queryByText('No keywords yet.')).not.toBeInTheDocument();
});

test('a slow initial load cannot overwrite the list a fresh add produced', async () => {
  const user = userEvent.setup();
  let releaseInitial = (): void => {};
  const initial = new Promise<KeywordNotificationView[]>((resolve) => {
    releaseInitial = () => {
      resolve([]);
    };
  });
  core.rpc.notifications.keywords.mockReturnValueOnce(initial);
  core.rpc.notifications.addKeyword.mockResolvedValue(null);

  render(NotificationKeywords);
  await user.type(input(), 'urgent');
  await user.click(screen.getByRole('button', { name: 'Add' }));

  await vi.waitFor(() => {
    expect(core.rpc.notifications.addKeyword).toHaveBeenCalledWith({ keyword: 'urgent' });
  });

  releaseInitial();
  await vi.waitFor(() => {
    expect(keywords()).toEqual(['urgent']);
  });
  await tick();

  expect(keywords()).toEqual(['urgent']);
  expect(core.rpc.notifications.keywords).toHaveBeenCalledTimes(1);
});

test('a removal survives a load that was already in flight', async () => {
  const user = userEvent.setup();
  let releaseInitial = (): void => {};
  const initial = new Promise<KeywordNotificationView[]>((resolve) => {
    releaseInitial = () => {
      resolve(listed('sable'));
    };
  });
  core.rpc.notifications.keywords.mockReturnValueOnce(initial);
  core.rpc.notifications.removeKeyword.mockResolvedValue(null);

  render(NotificationKeywords);
  releaseInitial();
  await vi.waitFor(() => {
    expect(keywords()).toEqual(['sable']);
  });

  const confirm = await confirmRemoval(user, 'sable');
  await confirm();

  await vi.waitFor(() => {
    expect(keywords()).toEqual([]);
  });
});

test('shows each keyword at its own level, including one disabled elsewhere', async () => {
  core.rpc.notifications.keywords.mockResolvedValue([
    { keyword: 'quiet', mode: 'off' },
    { keyword: 'urgent', mode: 'loud' },
  ]);

  render(NotificationKeywords);

  expect(await screen.findByLabelText('Notification level for urgent')).toHaveTextContent('Loud');
  expect(screen.getByLabelText('Notification level for quiet')).toHaveTextContent('Off');
});
