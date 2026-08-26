export type SwipeAction = 'none' | 'reply' | 'edit';

const REPLY_TRAVEL = 50;
const REPLY_FRACTION = 0.2;
const LINEAR_LIMIT = 60;
const LINEAR_LIMIT_FRACTION = 0.18;
const LINEAR_LIMIT_EDIT = 100;
const LINEAR_LIMIT_EDIT_FRACTION = 0.32;
const EDIT_TRAVEL = 90;
const MAX_EXCESS = 45;
const EXCESS_DECAY = 40;

export function replyThreshold(width: number): number {
  return Math.min(REPLY_TRAVEL, width * REPLY_FRACTION);
}

export function linearLimit(width: number, canEdit: boolean): number {
  return canEdit
    ? Math.min(LINEAR_LIMIT_EDIT, width * LINEAR_LIMIT_EDIT_FRACTION)
    : Math.min(LINEAR_LIMIT, width * LINEAR_LIMIT_FRACTION);
}

export function editThreshold(width: number, canEdit: boolean): number {
  return linearLimit(width, canEdit) + EDIT_TRAVEL;
}

export function swipeOffset(distanceX: number, width: number, canEdit: boolean): number {
  const dragged = Math.max(0, -distanceX);
  const limit = linearLimit(width, canEdit);
  if (dragged <= limit) return dragged;

  const excess = dragged - limit;
  return limit + MAX_EXCESS * (1 - Math.exp(-excess / EXCESS_DECAY));
}

export function swipeAction(distanceX: number, width: number, canEdit: boolean): SwipeAction {
  const dragged = Math.max(0, -distanceX);
  if (canEdit && dragged > editThreshold(width, canEdit)) return 'edit';
  if (dragged > replyThreshold(width)) return 'reply';
  return 'none';
}
