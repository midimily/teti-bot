export interface PanelScrollPosition {
  key: string;
  top: number;
  left: number;
}

const PANEL_SCROLL_SELECTOR = "[data-scroll-key]";

export function capturePanelScrollPositions(root: ParentNode): PanelScrollPosition[] {
  return Array.from(root.querySelectorAll<HTMLElement>(PANEL_SCROLL_SELECTOR))
    .filter((panel) => !panel.hidden)
    .map((panel) => ({
      key: panel.dataset.scrollKey ?? "",
      top: panel.scrollTop,
      left: panel.scrollLeft
    }))
    .filter((position) => position.key.length > 0);
}

export function restorePanelScrollPositions(
  root: ParentNode,
  positions: readonly PanelScrollPosition[],
  schedule: (callback: () => void) => void = queueMicrotask
): void {
  if (positions.length === 0) return;
  schedule(() => {
    const byKey = new Map(positions.map((position) => [position.key, position]));
    for (const panel of root.querySelectorAll<HTMLElement>(PANEL_SCROLL_SELECTOR)) {
      const key = panel.dataset.scrollKey;
      const position = key ? byKey.get(key) : undefined;
      if (!position || !panel.isConnected || panel.hidden) continue;
      panel.scrollTop = position.top;
      panel.scrollLeft = position.left;
    }
  });
}
