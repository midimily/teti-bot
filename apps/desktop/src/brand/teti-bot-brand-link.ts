import wordmarkSource from "../../assets/branding/teti-bot-wordmark.svg?raw";
import {
  openTetiBotWebsite,
  TETI_BOT_BRAND,
  type ExternalUrlOpener
} from "./teti-bot-website.ts";

export const TETI_BOT_OPENING_EVENT = "teti:brand-website-opening";
export const TETI_BOT_OPEN_SETTLED_EVENT = "teti:brand-website-open-settled";

export interface TetiBotBrandLinkOptions {
  ownerDocument?: Document;
  opener?: ExternalUrlOpener;
}

export function createTetiBotBrandLink(
  options: TetiBotBrandLinkOptions = {}
): HTMLButtonElement {
  const ownerDocument = options.ownerDocument ?? document;
  const button = ownerDocument.createElement("button");
  button.className = "teti-brand";
  button.type = "button";
  button.lang = "en";
  button.dir = "ltr";
  button.setAttribute("translate", "no");
  button.setAttribute("aria-label", `访问 ${TETI_BOT_BRAND} 官网`);
  button.dataset.brand = TETI_BOT_BRAND;

  const template = ownerDocument.createElement("template");
  template.innerHTML = wordmarkSource.trim();
  const wordmark = template.content.firstElementChild;
  if (!(wordmark instanceof SVGElement)) {
    throw new Error("Teti.bot wordmark SVG is unavailable.");
  }
  wordmark.classList.add("teti-brand-wordmark");
  wordmark.setAttribute("aria-hidden", "true");
  wordmark.setAttribute("focusable", "false");

  const fixedBrandText = ownerDocument.createElement("span");
  fixedBrandText.className = "teti-brand-fixed-text";
  fixedBrandText.textContent = TETI_BOT_BRAND;
  fixedBrandText.setAttribute("aria-hidden", "true");
  button.append(wordmark, fixedBrandText);

  // Keep this independent brand action from closing panels in the island's
  // delegated outside-click handlers.
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    button.dispatchEvent(new CustomEvent(TETI_BOT_OPENING_EVENT, { bubbles: true }));
    void openTetiBotWebsite(options.opener).then((opened) => {
      button.dispatchEvent(new CustomEvent(TETI_BOT_OPEN_SETTLED_EVENT, {
        bubbles: true,
        detail: { opened }
      }));
    });
  });
  return button;
}
