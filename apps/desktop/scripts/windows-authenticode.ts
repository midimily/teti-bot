import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { assertPortableExecutable } from "./windows-runtime.ts";

const execFileAsync = promisify(execFile);

export const WINDOWS_SIGNING_POLICY = Object.freeze({
  modeEnvironment: "TETI_WINDOWS_SIGNING_MODE",
  certificateEnvironment: "TETI_WINDOWS_CERTIFICATE_SHA1",
  signToolEnvironment: "TETI_WINDOWS_SIGNTOOL_PATH",
  timestampEnvironment: "TETI_WINDOWS_TIMESTAMP_URL",
  digestAlgorithm: "SHA256",
  timestampDigestAlgorithm: "SHA256"
});

export interface WindowsSigningConfiguration {
  certificateSha1: string;
  signToolPath: string;
  timestampUrl: string;
}

export interface WindowsAuthenticodeSignature {
  status: string;
  statusMessage: string;
  signerSubject: string;
  signerThumbprint: string;
  timestampSubject: string | null;
  timestampThumbprint: string | null;
}

export function isWindowsReleaseSigningEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env[WINDOWS_SIGNING_POLICY.modeEnvironment] === "release";
}

export function resolveWindowsSigningConfiguration(
  env: NodeJS.ProcessEnv = process.env
): WindowsSigningConfiguration {
  const certificateSha1 = normalizeCertificateSha1(
    env[WINDOWS_SIGNING_POLICY.certificateEnvironment]
  );
  const signToolPath = env[WINDOWS_SIGNING_POLICY.signToolEnvironment]?.trim() ?? "";
  const timestampUrl = env[WINDOWS_SIGNING_POLICY.timestampEnvironment]?.trim() ?? "";
  if (!isAbsolute(signToolPath) || !/signtool\.exe$/i.test(signToolPath)) {
    throw new Error("TETI_WINDOWS_SIGNTOOL_PATH must be an absolute path to signtool.exe.");
  }
  let parsedTimestamp: URL;
  try {
    parsedTimestamp = new URL(timestampUrl);
  } catch {
    throw new Error("TETI_WINDOWS_TIMESTAMP_URL must be a valid HTTPS timestamp URL.");
  }
  if (parsedTimestamp.protocol !== "https:") {
    throw new Error("TETI_WINDOWS_TIMESTAMP_URL must use HTTPS.");
  }
  return { certificateSha1, signToolPath, timestampUrl: parsedTimestamp.toString() };
}

export function normalizeCertificateSha1(value: string | undefined): string {
  const normalized = (value ?? "").replace(/[\s:]/g, "").toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(normalized)) {
    throw new Error("TETI_WINDOWS_CERTIFICATE_SHA1 must contain exactly 40 hexadecimal digits.");
  }
  return normalized;
}

export async function signWindowsPeFile(
  path: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<WindowsAuthenticodeSignature> {
  assertWindowsX64Host();
  const configuration = resolveWindowsSigningConfiguration(env);
  if (!isAbsolute(path) || !/\.(?:exe|dll)$/i.test(path)) {
    throw new Error("Authenticode input must be an absolute .exe or .dll path.");
  }
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Authenticode input is not a regular file.");
  await assertPortableExecutable(path, "x86_64", "Authenticode input");
  await execFileAsync(configuration.signToolPath, [
    "sign",
    "/sha1",
    configuration.certificateSha1,
    "/fd",
    WINDOWS_SIGNING_POLICY.digestAlgorithm,
    "/tr",
    configuration.timestampUrl,
    "/td",
    WINDOWS_SIGNING_POLICY.timestampDigestAlgorithm,
    "/v",
    path
  ], { windowsHide: true, timeout: 120_000 });
  await execFileAsync(configuration.signToolPath, ["verify", "/pa", "/all", "/v", path], {
    windowsHide: true,
    timeout: 120_000
  });
  const signature = await readWindowsAuthenticodeSignature(path);
  assertExpectedWindowsSignature(signature, configuration.certificateSha1, path);
  return signature;
}

export async function readWindowsAuthenticodeSignature(
  path: string
): Promise<WindowsAuthenticodeSignature> {
  assertWindowsX64Host();
  const script = [
    "$p=[Environment]::GetEnvironmentVariable('TETI_SIGNATURE_INPUT')",
    "$s=Get-AuthenticodeSignature -LiteralPath $p",
    "[ordered]@{status=[string]$s.Status;statusMessage=[string]$s.StatusMessage;signerSubject=[string]$s.SignerCertificate.Subject;signerThumbprint=[string]$s.SignerCertificate.Thumbprint;timestampSubject=if($s.TimeStamperCertificate){[string]$s.TimeStamperCertificate.Subject}else{$null};timestampThumbprint=if($s.TimeStamperCertificate){[string]$s.TimeStamperCertificate.Thumbprint}else{$null}}|ConvertTo-Json -Compress"
  ].join(";");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ], {
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, TETI_SIGNATURE_INPUT: path }
  });
  const value = JSON.parse(stdout.trim()) as WindowsAuthenticodeSignature;
  if (!value || typeof value.status !== "string" || typeof value.signerThumbprint !== "string") {
    throw new Error(`Unable to read Authenticode signature for ${path}.`);
  }
  return value;
}

export function assertExpectedWindowsSignature(
  signature: WindowsAuthenticodeSignature,
  certificateSha1: string,
  label: string
): void {
  if (signature.status !== "Valid") throw new Error(`${label} has invalid Authenticode status.`);
  if (normalizeCertificateSha1(signature.signerThumbprint) !== certificateSha1) {
    throw new Error(`${label} was not signed by the configured Teti certificate.`);
  }
  if (!signature.timestampThumbprint) throw new Error(`${label} has no trusted timestamp signature.`);
}

export async function sha256WindowsArtifact(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function assertWindowsX64Host(): void {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Windows release signing requires a real Windows x64 host.");
  }
}
