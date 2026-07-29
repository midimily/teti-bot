export const CONNECTION_WINDOW_BASE_HEIGHT = 352;
export const CONNECTION_WINDOW_BOTTOM_MARGIN = 24;
export const CONNECTION_WINDOW_MAX_HEIGHT = 1_200;
export const CONNECTION_DETAIL_MIN_VIEWPORT = 96;

export interface ConnectionDetailLayout {
  windowHeight: number;
  detailViewportHeight: number;
  detailConstrained: boolean;
  listConstrained: boolean;
}

export function resolveConnectionDetailLayout(
  naturalWindowHeight: number,
  naturalDetailHeight: number,
  screenHeight: number
): ConnectionDetailLayout {
  const detailHeight = finiteNonNegative(naturalDetailHeight);
  const naturalHeight = Math.max(
    CONNECTION_WINDOW_BASE_HEIGHT,
    finiteNonNegative(naturalWindowHeight)
  );
  const nonDetailHeight = Math.max(0, naturalHeight - detailHeight);
  const usableScreenHeight = Math.max(
    CONNECTION_WINDOW_BASE_HEIGHT,
    Math.min(
      CONNECTION_WINDOW_MAX_HEIGHT,
      finitePositive(screenHeight, CONNECTION_WINDOW_BASE_HEIGHT + CONNECTION_WINDOW_BOTTOM_MARGIN)
        - CONNECTION_WINDOW_BOTTOM_MARGIN
    )
  );
  const detailViewportHeight = Math.min(
    detailHeight,
    Math.max(0, usableScreenHeight - nonDetailHeight)
  );

  return {
    windowHeight: Math.round(Math.min(
      usableScreenHeight,
      Math.max(CONNECTION_WINDOW_BASE_HEIGHT, nonDetailHeight + detailViewportHeight)
    )),
    detailViewportHeight: Math.round(detailViewportHeight),
    detailConstrained: detailViewportHeight < detailHeight,
    listConstrained: detailHeight > 0
      && detailViewportHeight < Math.min(detailHeight, CONNECTION_DETAIL_MIN_VIEWPORT)
  };
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.ceil(value)) : 0;
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
