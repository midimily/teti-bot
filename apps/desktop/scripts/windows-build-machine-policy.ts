import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface WindowsBuildMachinePolicy {
  schemaVersion: 1;
  policyId: string;
  platform: "win32";
  architecture: "x64";
  installRoot: string;
  os: { product: "Windows 11"; minimumBuild: number };
  node: {
    version: string;
    npmVersion: string;
    archiveFileName: string;
    archiveUrl: string;
    archiveSha256: string;
    runtimeFileName: "node.exe";
    runtimeUrl: string;
    runtimeSha256: string;
  };
  rustup: { version: string; fileName: string; url: string; sha256: string };
  rust: {
    version: string;
    toolchain: string;
    host: "x86_64-pc-windows-msvc";
    target: "x86_64-pc-windows-msvc";
    profile: "minimal";
    components: string[];
  };
  cargo: {
    configFile: string;
    configSha256: string;
    registrySource: "rsproxy-sparse";
    registryUrl: "sparse+https://rsproxy.cn/index/";
  };
  visualStudio: {
    product: string;
    productId: string;
    productVersion: string;
    installationVersion: string;
    channelId: string;
    installPath: string;
    bootstrapperFileName: string;
    bootstrapperUrl: string;
    bootstrapperSha256: string;
    msvcToolsetPrefix: string;
    compilerVersionPrefix: string;
    components: string[];
  };
  windowsSdk: { version: string };
  cmake: { version: string };
  perl: {
    distributionVersion: string;
    runtimeVersion: string;
    archiveFileName: string;
    archiveUrl: string;
    archiveSha256: string;
  };
  nasm: {
    version: string;
    archiveFileName: string;
    extractedDirectoryName: string;
    archiveUrl: string;
    archiveSha256: string;
  };
  deltaChat: {
    repository: string;
    revision: string;
    version: string;
    sourceDateEpoch: number;
    cargoLockSha256: string;
    cargoPackage: string;
    cargoFeatures: string[];
    fileName: "deltachat-rpc-server.exe";
  };
}

export const WINDOWS_BUILD_MACHINE_POLICY_PATH = fileURLToPath(
  new URL("../../../toolchains/windows-x64-build-machine.json", import.meta.url)
);

export const WINDOWS_BUILD_MACHINE_POLICY = Object.freeze(
  parseWindowsBuildMachinePolicy(readFileSync(WINDOWS_BUILD_MACHINE_POLICY_PATH, "utf8"))
);

function parseWindowsBuildMachinePolicy(source: string): WindowsBuildMachinePolicy {
  const value = JSON.parse(source) as Partial<WindowsBuildMachinePolicy>;
  if (value.schemaVersion !== 1
    || value.platform !== "win32"
    || value.architecture !== "x64"
    || value.os?.product !== "Windows 11"
    || value.rust?.target !== "x86_64-pc-windows-msvc"
    || value.rust?.host !== "x86_64-pc-windows-msvc"
    || value.cargo?.registrySource !== "rsproxy-sparse"
    || value.cargo?.registryUrl !== "sparse+https://rsproxy.cn/index/"
    || value.node?.runtimeFileName !== "node.exe"
    || value.nasm?.extractedDirectoryName !== `nasm-${value.nasm?.version}`
    || value.deltaChat?.fileName !== "deltachat-rpc-server.exe") {
    throw new Error("Windows build-machine policy has an invalid platform contract.");
  }
  const hashes = [
    value.node.archiveSha256,
    value.node.runtimeSha256,
    value.cargo?.configSha256,
    value.rustup?.sha256,
    value.visualStudio?.bootstrapperSha256,
    value.perl?.archiveSha256,
    value.nasm?.archiveSha256,
    value.deltaChat?.cargoLockSha256
  ];
  if (hashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("Windows build-machine policy contains an invalid SHA-256 pin.");
  }
  if (!Array.isArray(value.visualStudio?.components)
    || value.visualStudio.components.length < 4
    || !Array.isArray(value.deltaChat?.cargoFeatures)
    || value.deltaChat.cargoFeatures.length === 0
    || typeof value.deltaChat.revision !== "string"
    || !/^[a-f0-9]{40}$/.test(value.deltaChat.revision)) {
    throw new Error("Windows build-machine policy contains incomplete build inputs.");
  }
  return value as WindowsBuildMachinePolicy;
}
