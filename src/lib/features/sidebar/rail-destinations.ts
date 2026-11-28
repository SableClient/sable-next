export interface RailDestination {
  href: string;
  active: boolean;
}

interface Rail {
  destinations: () => readonly RailDestination[];
  navigate: (href: string) => void;
}

let rail: Rail | null = null;

/** The desktop space rail registers its top-level destinations in the order it shows them. */
export function provideRail(next: Rail): () => void {
  rail = next;
  return () => {
    if (rail === next) rail = null;
  };
}

function destinationAtOffset(
  destinations: readonly RailDestination[],
  offset: 1 | -1
): string | null {
  if (destinations.length === 0) return null;

  const index = destinations.findIndex((destination) => destination.active);
  if (index === -1)
    return (offset > 0 ? destinations[0] : destinations[destinations.length - 1]).href;

  const target = destinations[(index + offset + destinations.length) % destinations.length];
  return target.active ? null : target.href;
}

export function switchSpace(offset: 1 | -1): void {
  if (!rail) return;
  const target = destinationAtOffset(rail.destinations(), offset);
  if (target) rail.navigate(target);
}
