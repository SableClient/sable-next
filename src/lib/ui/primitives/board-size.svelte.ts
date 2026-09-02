export interface BoardSize {
  width: number;
  height: number;
}

const storageKey = 'sable.composer.boardSize';

const state = $state<{ size: BoardSize | null }>({ size: load() });

function load(): BoardSize | null {
  if (typeof localStorage === 'undefined') return null;

  try {
    return parse(JSON.parse(localStorage.getItem(storageKey) ?? 'null'));
  } catch {
    return null;
  }
}

function parse(value: unknown): BoardSize | null {
  if (typeof value !== 'object' || value === null) return null;
  const { width, height } = value as Record<string, unknown>;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
}

export function readBoardSize(): BoardSize | null {
  return state.size;
}

function writeBoardSize(size: BoardSize): void {
  state.size = size;
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.setItem(storageKey, JSON.stringify(size));
  } catch (error) {
    console.debug('[sable board] size not persisted', error);
  }
}

export function trackBoardSize(element: HTMLElement): () => void {
  const observer = new MutationObserver(() => {
    const width = Number.parseFloat(element.style.width);
    const height = Number.parseFloat(element.style.height);
    if (Number.isFinite(width) && Number.isFinite(height)) writeBoardSize({ width, height });
  });
  observer.observe(element, { attributeFilter: ['style'] });
  return () => {
    observer.disconnect();
  };
}
