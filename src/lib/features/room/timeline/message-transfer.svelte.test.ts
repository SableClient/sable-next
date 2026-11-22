// @vitest-environment happy-dom

import { expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

import { imageItem, item } from './timeline-item-fixtures';
import { MessageTransfer, type MessageTransferOptions } from './message-transfer.svelte';

function transferFor(
  view: TimelineItemView,
  patch: Partial<MessageTransferOptions> = {}
): MessageTransfer {
  return new MessageTransfer(() => ({
    item: view,
    pending: false,
    savingPercent: null,
    savingSlow: false,
    onCancel: vi.fn(),
    ...patch,
  }));
}

test('shows nothing for a settled message', () => {
  const transfer = transferFor(item(false));
  expect(transfer.upload).toBeNull();
  expect(transfer.props).toBeNull();
});

test('reports upload progress and offers cancel while sending', () => {
  const onCancel = vi.fn();
  const view = {
    ...imageItem(),
    transaction_id: 'txn',
    send_state: { status: 'sending' as const, progress: { index: 0, current: 5, total: 10 } },
  };
  const transfer = transferFor(view, { pending: true, onCancel });
  expect(transfer.upload).toEqual({ index: 0, current: 5, total: 10 });
  expect(transfer.props).toMatchObject({ max: 1, value: 0.5, count: null, onCancel });
});

test('omits cancel without a transaction id', () => {
  const transfer = transferFor(imageItem(), { pending: true });
  expect(transfer.props).not.toBeNull();
  expect(transfer.props?.label).toBeTruthy();
  expect(transfer.props && 'onCancel' in transfer.props ? transfer.props.onCancel : null).toBe(
    undefined
  );
  expect(transfer.props && 'max' in transfer.props).toBe(false);
});

test('shows download progress, then the slow state', () => {
  const view = item(false);
  expect(transferFor(view, { savingPercent: 40 }).props).toMatchObject({ max: 100, value: 40 });
  const slow = transferFor(view, { savingSlow: true }).props;
  expect(slow).not.toBeNull();
  expect(slow?.label).toBeTruthy();
  expect(slow && 'max' in slow).toBe(false);
});
