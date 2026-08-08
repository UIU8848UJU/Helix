export interface BrowserSettings {
  headless: boolean;
  defaultTimeoutSeconds: number;
  maxReadBytes: number;
  auditEnabled: boolean;
}

export interface StorageStateMapping {
  domain: string;
  path: string;
}

export interface BrowserConfig {
  version: 1;
  settings: BrowserSettings;
  allowedDomains: string[];
  storageStates: StorageStateMapping[];
}