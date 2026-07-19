import { openUrl } from "@tauri-apps/plugin-opener";

export const TETI_BOT_BRAND = "Teti.bot";
export const TETI_BOT_URL = "https://teti.bot/";

export type ExternalUrlOpener = (url: string) => Promise<void>;
export type BrandDiagnosticLogger = Pick<Console, "warn">;

export async function openTetiBotWebsite(
  opener: ExternalUrlOpener = openUrl,
  logger: BrandDiagnosticLogger = console
): Promise<boolean> {
  try {
    await opener(TETI_BOT_URL);
    return true;
  } catch (error) {
    logger.warn("Teti.bot website could not be opened in the system browser.", {
      url: TETI_BOT_URL,
      error
    });
    return false;
  }
}
