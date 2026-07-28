# Teti Beta 0.1.15 — Collaboration Reliability

Status: implemented with known multi-image physical-delivery defect; superseded by the 0.2.0 breaking baseline

Application version: `0.1.15`

Implemented on: 2026-07-28

## Scope

- Result image cards provide explicit Open, Show in Finder, and Save As actions.
  Native commands accept only canonical PNG/JPEG files inside Teti's verified
  Artifact store.
- Task protocol v4 requests a durable receipt for every input and result image.
  Senders persist attempts and retry only missing attachment IDs with bounded
  backoff until the peer confirms durable ingestion or the Task expires.
- The macOS image picker is parented to the active Teti window so the file panel
  remains attached to the existing application activation on macOS 26.5.2.
- Composer send eligibility is recalculated from the live draft on every text
  input rather than from the snapshot that originally rendered the textarea.
- Peer presence uses relay receive time, never the peer payload clock. A fresh
  heartbeat is Online, a short missed-heartbeat interval is Checking, and the
  peer becomes Offline after a bounded 45-second grace window.

## Compatibility

Application Envelope remains version 1. Task v1-v3 peers keep their existing
behavior. Per-attachment receipts and retransmission are enabled only when both
peers negotiate Task v4. Unknown peers still receive compatibility-floor v1.

This compatibility behavior is historical and is removed by Beta 0.2.0.

## Known defect accepted for the 0.2.0 upgrade cycle

`KD-0.1.15-MULTI-IMAGE-DELIVERY`: physical dual-Teti Tasks with two or four
image attachments have a high probability of incomplete delivery, while a
single image usually arrives successfully. This means the physical completion
gate below did not pass as originally written.

Beta 0.2.0 temporarily tolerates only that completion-rate failure. Missing or
misbound images, duplicate false counts, hash mismatch, incomplete approval or
execution, and false completion remain blockers. The defect must be re-tested
after both Macs complete one 0.2 upgrade cycle.

## Automated gates

- strict v4 attachment and attachment-receipt validation;
- four-image request with two deliberately dropped attachments, selective
  retransmission, durable verification, and four final receipts;
- live composer eligibility and native result action command wiring;
- parented native image dialogs;
- Online, Checking, Offline, missing, invalid, and future heartbeat states;
- full TypeScript, Node test, Vite build, Rust format, and Cargo checks.

## Physical gates

1. On macOS 26.5.2, select one and four images and confirm the Teti Dock icon
   does not bounce or jump while the picker opens and closes.
2. After the 0.2 upgrade cycle, repeat two- and four-image delivery, record the
   completion rate, and confirm an incomplete receiver remains non-actionable.
3. Open, reveal, and save a received result image from its action buttons.
4. Type a task description after selecting the peer and capability and confirm
   Send becomes enabled immediately and remains correct after image selection.
5. Pause one peer long enough to observe Online → Checking → Offline, then
   resume it and confirm the next heartbeat restores Online.
