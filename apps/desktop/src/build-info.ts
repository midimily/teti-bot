export interface TetiBuildInfo {
  appVersion: string;
  buildTimestamp: string;
}

const injectedVersion = typeof __TETI_APP_VERSION__ === "string"
  ? __TETI_APP_VERSION__
  : "development";
const injectedTimestamp = typeof __TETI_BUILD_TIMESTAMP__ === "string"
  ? __TETI_BUILD_TIMESTAMP__
  : "development";

/** Values are replaced in both the WebView and lifecycle sidecar at build time. */
export const TETI_BUILD_INFO: Readonly<TetiBuildInfo> = Object.freeze({
  appVersion: injectedVersion,
  buildTimestamp: injectedTimestamp
});
