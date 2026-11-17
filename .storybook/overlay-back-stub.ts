export function overlayBackDepth(state: App.PageState): number {
  return state.overlay ?? 0;
}

export async function afterOverlayPops(): Promise<void> {}

export function holdOverlayBack(): void {}
