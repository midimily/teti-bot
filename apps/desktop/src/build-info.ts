export interface TetiBuildInfo {
  appVersion: string;
  buildTimestamp: string;
  buildType: "development" | "release";
  localDevelopmentNetworkSwitchEnabled: boolean;
}

const injectedVersion = typeof __TETI_APP_VERSION__ === "string"
  ? __TETI_APP_VERSION__
  : "development";
const injectedTimestamp = typeof __TETI_BUILD_TIMESTAMP__ === "string"
  ? __TETI_BUILD_TIMESTAMP__
  : "development";
const injectedBuildType = typeof __TETI_BUILD_TYPE__ === "string"
  && __TETI_BUILD_TYPE__ === "release"
  ? "release"
  : "development";

/** Values are replaced in both the WebView and lifecycle sidecar at build time. */
export const TETI_BUILD_INFO: Readonly<TetiBuildInfo> = Object.freeze({
  appVersion: injectedVersion,
  buildTimestamp: injectedTimestamp,
  buildType: injectedBuildType,
  // Temporarily keep the local Network environment out of both internal test
  // builds and prerelease packages. The Runtime also consumes this flag, so a
  // persisted local-development preference cannot remain active while hidden.
  localDevelopmentNetworkSwitchEnabled: false
});
