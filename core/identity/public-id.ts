export const TETI_PUBLIC_ID_PREFIX = "teti_";
export const TETI_PUBLIC_ID_CODE_LENGTH = 9;
export const TETI_CHATMAIL_DOMAIN = "mail.seep.im";
export const TETI_PUBLIC_ID_CODE_CHARACTERS_PATTERN = /^[a-z0-9]*$/;
export const TETI_PUBLIC_ID_CODE_PATTERN = /^[a-z0-9]{9}$/;
export const TETI_PUBLIC_ID_PATTERN = /^teti_[a-z0-9]{9}$/;
export const TETI_CHATMAIL_ADDRESS_PATTERN = /^[a-z0-9]{9}@mail\.seep\.im$/;

export function normalizeTetiPublicIdCode(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Teti public ID code must be a string.");
  }
  const normalized = value.trim().toLowerCase();
  if (!TETI_PUBLIC_ID_CODE_PATTERN.test(normalized)) {
    throw new Error("Teti public ID code must contain exactly 9 ASCII lowercase letters or numbers.");
  }
  return normalized;
}

export function normalizeTetiPublicId(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Teti public ID must be a string.");
  }
  const normalized = value.trim().toLowerCase();
  if (!TETI_PUBLIC_ID_PATTERN.test(normalized)) {
    throw new Error("Teti public ID must match teti_ followed by exactly 9 ASCII lowercase letters or numbers.");
  }
  return normalized;
}

export function isCanonicalTetiPublicId(value: unknown): value is string {
  return typeof value === "string" && TETI_PUBLIC_ID_PATTERN.test(value);
}

export function normalizeTetiChatmailAddress(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Teti Chatmail address must be a string.");
  }
  const normalized = value.trim().toLowerCase();
  if (!TETI_CHATMAIL_ADDRESS_PATTERN.test(normalized)) {
    throw new Error("Teti Chatmail address must use a 9-character ASCII lowercase local part at mail.seep.im.");
  }
  return normalized;
}

export function isCanonicalTetiChatmailAddress(
  value: unknown,
  publicId?: string
): value is string {
  if (typeof value !== "string" || !TETI_CHATMAIL_ADDRESS_PATTERN.test(value)) return false;
  return publicId === undefined || `teti_${value.slice(0, TETI_PUBLIC_ID_CODE_LENGTH)}` === publicId;
}

export function tetiPublicIdFromAddress(address: string): string {
  const canonicalAddress = normalizeTetiChatmailAddress(address);
  return `${TETI_PUBLIC_ID_PREFIX}${canonicalAddress.slice(0, TETI_PUBLIC_ID_CODE_LENGTH)}`;
}
