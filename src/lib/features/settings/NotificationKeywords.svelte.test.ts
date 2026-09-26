// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import type { KeywordNotificationView, MentionNotificationModeView } from '#src/generated/protocol';
import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  notificationKeywords: vi.fn<() => Promise<KeywordNotificationView[]>>(),
  addNotificationKeyword: vi.fn<(keyword: string) => Promise<void>>(),
  removeNotificationKeyword: vi.fn<(keyword: string) => Promise<void>>(),
  setNotificationKeywordMode:
    vi.fn<(keyword: string, mode: MentionNotificationModeView) => Promise<void>>(),
});

function listed(...keywords: string[]): KeywordNotificationView[] {
  return keywords.map((keyword) => ({ keyword, mode: 'notify' }));
}

import NotificationKeywords from './NotificationKeywords.svelte';

afterEach(() => {
  vi.clearAllMocks();
});

const keywords = () =>
  screen.queryAllByRole('listitem').map((item) => item.querySelector('.keyword-text')?.textContent);
const input = () => screen.getByRole('textbox', { name: 'Add a keyword' });

async function confirmRemoval(user: ReturnType<typeof userEvent.setup>, keyword: string) {
  await user.click(screen.getByRole('button', { name: `Remove keyword ${keyword}` }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent(`Remove keyword ${keyword}?`);
  return () => user.click(within(dialog).getByRole('button', { name: 'Remove' }));
}

test('lists the account keywords and lets one be removed', async () => {
  const user = userEvent.setup();
  core.notificationKeywords.mockResolvedValueOnce(listed('erwan', 'sable'));
  core.notificationKeywords.mockResolvedValueOnce(listed('sable'));
  core.removeNotificationKeyword.mockResolvedValue(undefined);

  render(NotificationKeywords);
  await vi.waitFor(() => {
    expect(keywords()).toEqual(['erwan', 'sable']);
  });

  const confirm = await confirmRemoval(user, 'erwan');
  expect(core.removeNotificationKeyword).not.toHaveBeenCalled();
  await confirm();

  await vi.waitFor(() => {
    expect(core.removeNotificationKeyword).toHaveBeenCalledWith('erwan');
    expect(keywords()).toEqual(['sable']);
  });
});

test('refuses a blank or whitespace-only keyword', async () => {
  const user = userEvent.setup();
  core.notificationKeywords.mockResolvedValue([]);

  render(NotificationKeywords);
  await vi.waitFor(() => {
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  await user.type(input(), '   {Enter}');

  expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  expect(core.addNotificationKeyword).not.toHaveBeenCalled();
});

test('does not add a keyword already in the list', async () => {
  const user = userEvent.setup();
  core.notificationKeywords.mockResolvedValue(listed('sable'));

  render(NotificationKeywords);
  await vi.waitFor(() => {
    expect(keywords()).toEqual(['sable']);
  });

  await user.type(input(), 'sable{Enter}');

  expect(core.addNotificationKeyword).not.toHaveBeenCalled();
});

test('does not leave the list showing an add the server rejected', async () => {
  const user = userEvent.setup();
  core.notificationKeywords.mockResolvedValue(listed('sable'));
  core.addNotificationKeyword.mockRejectedValue(new Error('denied'));

  render(NotificationKeywords);
  await vi.waitFor(() => {
    expect(keywords()).toEqual(['sable']);
  });

  await user.type(input(), 'erwan{Enter}');

  expect(await screen.findByRole('status')).toHaveTextContent('That keyword could not be added.');
  expect(keywords()).toEqual(['sable']);
  expect(core.notificationKeywords).toHaveBeenCalledTimes(1);
});

test('reports a load failure instead of showing an empty list', async () => {
  core.notificationKeywords.mockRejectedValue(new Error('denied'));

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
  core.notificationKeywords.mockReturnValueOnce(initial);
  core.addNotificationKeyword.mockResolvedValue(undefined);

  render(NotificationKeywords);
  await user.type(input(), 'urgent');
  await user.click(screen.getByRole('button', { name: 'Add' }));

  await vi.waitFor(() => {
    expect(core.addNotificationKeyword).toHaveBeenCalledWith('urgent');
  });

  releaseInitial();
  await vi.waitFor(() => {
    expect(keywords()).toEqual(['urgent']);
  });
  await tick();

  expect(keywords()).toEqual(['urgent']);
  expect(core.notificationKeywords).toHaveBeenCalledTimes(1);
});

test('a removal survives a load that was already in flight', async () => {
  const user = userEvent.setup();
  let releaseInitial = (): void => {};
  const initial = new Promise<KeywordNotificationView[]>((resolve) => {
    releaseInitial = () => {
      resolve(listed('sable'));
    };
  });
  core.notificationKeywords.mockReturnValueOnce(initial);
  core.removeNotificationKeyword.mockResolvedValue(undefined);

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
  core.notificationKeywords.mockResolvedValue([
    { keyword: 'quiet', mode: 'off' },
    { keyword: 'urgent', mode: 'loud' },
  ]);

  render(NotificationKeywords);

  expect(await screen.findByLabelText('Notification level for urgent')).toHaveTextContent('Loud');
  expect(screen.getByLabelText('Notification level for quiet')).toHaveTextContent('Off');
});
