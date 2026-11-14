class FindOrJoinState {
  open = $state(false);
  initial = $state('');
}

export const findOrJoinState = new FindOrJoinState();

export function openFindOrJoin(initial = ''): void {
  findOrJoinState.initial = initial;
  findOrJoinState.open = true;
}
