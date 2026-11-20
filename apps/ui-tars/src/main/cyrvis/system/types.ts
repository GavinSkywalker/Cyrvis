/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export type ApplicationSource =
  | 'start-app'
  | 'registry'
  | 'applications-folder'
  | 'desktop-entry'
  | 'steam';

export interface InstalledApplication {
  id: string;
  name: string;
  source: ApplicationSource;
  version?: string;
  publisher?: string;
  executable?: string;
  launchTarget?: string;
  installLocation?: string;
}

export interface SteamLibrary {
  path: string;
  apps: number[];
}

export interface SteamGame {
  appId: string;
  name: string;
  installDirectory: string;
  libraryPath: string;
  sizeBytes?: number;
}

export interface DiskState {
  name: string;
  mountPoint: string;
  totalBytes: number;
  freeBytes: number;
}

export interface NetworkInterfaceState {
  name: string;
  addresses: Array<{
    address: string;
    family: string;
    internal: boolean;
  }>;
}

export interface BatteryState {
  percent: number;
  charging: boolean;
  estimatedMinutes?: number;
}

export interface ServiceState {
  name: string;
  displayName: string;
  status: string;
  startType: string;
}

export interface RecentFileState {
  name: string;
  path: string;
  lastUsedAt: number;
}

export interface SystemStateSnapshot {
  capturedAt: number;
  runtimeObservedAt: number;
  fullObservedAt: number;
  platform: NodeJS.Platform;
  release: string;
  version: string;
  architecture: string;
  hostname: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  uptimeSeconds: number;
  disks: DiskState[];
  networkInterfaces: NetworkInterfaceState[];
  battery: BatteryState | null;
  installedApplications: InstalledApplication[];
  steamGames: SteamGame[];
  services: ServiceState[];
  recentFiles: RecentFileState[];
  runningProcesses: Array<{
    pid: number;
    name: string;
    title?: string;
    memoryBytes?: number;
  }>;
  windows: Array<{
    pid: number;
    process: string;
    title: string;
    focused?: boolean;
    handle?: number;
  }>;
  capabilities: string[];
}
