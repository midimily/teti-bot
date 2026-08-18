export const TETI_DISPLAY_NAME_MIN_CHARACTERS = 1;
export const TETI_DISPLAY_NAME_MAX_CHARACTERS = 10;

export type DisplayNameValidationReason =
  | "empty"
  | "too_long"
  | "control_character";

export type DisplayNameValidationResult =
  | { ok: true; value: string; characterCount: number }
  | {
      ok: false;
      reason: DisplayNameValidationReason;
      characterCount: number;
      maximumCharacters?: number;
    };

export class InvalidDisplayNameError extends Error {
  readonly reason: DisplayNameValidationReason;

  constructor(reason: DisplayNameValidationReason) {
    super(`Invalid Teti display name: ${reason}.`);
    this.name = "INVALID_NAME";
    this.reason = reason;
  }
}

export function validateTetiDisplayName(input: string): DisplayNameValidationResult {
  const value = input.normalize("NFC").trim();
  const characterCount = countUnicodeCharacters(value);

  if (characterCount < TETI_DISPLAY_NAME_MIN_CHARACTERS) {
    return { ok: false, reason: "empty", characterCount };
  }
  if (characterCount > TETI_DISPLAY_NAME_MAX_CHARACTERS) {
    return {
      ok: false,
      reason: "too_long",
      characterCount,
      maximumCharacters: TETI_DISPLAY_NAME_MAX_CHARACTERS
    };
  }
  if (hasControlCharacter(value)) {
    return { ok: false, reason: "control_character", characterCount };
  }

  return { ok: true, value, characterCount };
}

export function truncateTetiDisplayName(input: string): string {
  return Array.from(input).slice(0, TETI_DISPLAY_NAME_MAX_CHARACTERS).join("");
}

export function countUnicodeCharacters(input: string): number {
  return Array.from(input).length;
}

function hasControlCharacter(input: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(input);
}
