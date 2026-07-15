export interface DetectedAiTool {
  id: string;
  name: string;
  source: "command" | "application" | "extension" | "mock";
}

export interface EnvironmentScan {
  platform: string;
  device: EnvironmentDeviceMetadata;
  location?: EnvironmentLocationMetadata;
  aiTools: DetectedAiTool[];
  timestamp: string;
}

export interface PublicEnvironmentProfile {
  platform: string;
  device: EnvironmentDeviceMetadata;
  location?: EnvironmentLocationMetadata;
  aiEnvironment: string[];
  lastSeen: string;
}

export interface EnvironmentDeviceMetadata {
  os: {
    name: string;
    version: string;
  };
  hardware: {
    vendor?: string;
    model?: string;
    architecture: string;
  };
}

export interface EnvironmentLocationMetadata {
  country?: string;
  city?: string;
}

export interface EnvironmentDetectorContext {
  platform: string;
  commandExists(command: string): Promise<boolean>;
  pathExists(path: string): Promise<boolean>;
  listDirectory(path: string): Promise<string[]>;
}

export interface EnvironmentDetector {
  id: string;
  detect(context: EnvironmentDetectorContext): Promise<DetectedAiTool[]>;
}

export interface ScanEnvironmentOptions {
  detectors?: EnvironmentDetector[];
  now?: () => string;
  platform?: string;
  device?: Partial<EnvironmentDeviceMetadata>;
  location?: EnvironmentLocationMetadata;
}
