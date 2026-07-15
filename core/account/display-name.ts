export const TETI_DISPLAY_NAME_MIN_CHARACTERS = 1;
export const TETI_DISPLAY_NAME_MAX_CHARACTERS = 10;

export type DisplayNameValidationResult =
  | { ok: true; value: string; characterCount: number }
  | { ok: false; message: string; characterCount: number };

export function validateTetiDisplayName(input: string): DisplayNameValidationResult {
  const value = input.normalize("NFC").trim();
  const characterCount = countUnicodeCharacters(value);

  if (characterCount < TETI_DISPLAY_NAME_MIN_CHARACTERS) {
    return { ok: false, message: "先给 Teti 一个名字。", characterCount };
  }
  if (characterCount > TETI_DISPLAY_NAME_MAX_CHARACTERS) {
    return {
      ok: false,
      message: `名字最多 ${TETI_DISPLAY_NAME_MAX_CHARACTERS} 个字符。`,
      characterCount
    };
  }
  if (hasControlCharacter(value)) {
    return { ok: false, message: "名字不能包含控制字符。", characterCount };
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
