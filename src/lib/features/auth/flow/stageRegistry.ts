export interface AuthStage {
  route: string;
  title: string;
  completed: boolean;
  accessibilityLabel: string;
}

export function stageIndexForPath(pathname: string, stages: readonly AuthStage[]): number {
  let bestIndex = 0;
  let bestLength = -1;

  stages.forEach(({ route }, index) => {
    const matches = pathname === route || pathname.startsWith(`${route}/`);
    if (matches && route.length > bestLength) {
      bestIndex = index;
      bestLength = route.length;
    }
  });

  return bestIndex;
}

export function furthestReachableStage(
  requestedIndex: number,
  stages: readonly AuthStage[]
): number {
  const firstIncomplete = stages.findIndex((stage) => !stage.completed);
  const furthest = firstIncomplete < 0 ? stages.length - 1 : firstIncomplete;
  return Math.min(Math.max(requestedIndex, 0), furthest);
}
