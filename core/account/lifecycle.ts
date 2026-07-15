import { TetiAccountManager, type TetiAccountManagerOptions } from "./manager.ts";
import type { CreateTetiAccountInput, TetiAccount, TetiStatus } from "./model.ts";

export async function createTetiAccount(
  input: CreateTetiAccountInput = {},
  options: TetiAccountManagerOptions = {}
): Promise<TetiAccount> {
  return new TetiAccountManager(options).createTetiAccount(input);
}

export async function loadTetiAccount(
  options: TetiAccountManagerOptions = {}
): Promise<TetiAccount | null> {
  return new TetiAccountManager(options).loadTetiAccount();
}

export async function getTetiStatus(
  options: TetiAccountManagerOptions = {}
): Promise<TetiStatus> {
  return new TetiAccountManager(options).getTetiStatus();
}

export async function deleteTetiAccount(
  options: TetiAccountManagerOptions = {}
): Promise<void> {
  return new TetiAccountManager(options).deleteTetiAccount();
}

export async function refreshTetiEnvironment(
  options: TetiAccountManagerOptions = {}
): Promise<TetiAccount> {
  return new TetiAccountManager(options).refreshTetiEnvironment();
}

export { TetiAccountManager };
export type { TetiAccountManagerOptions };
