-- 0153 Client logo formats (CLIENT-02; ruled `CLIENT-round1-RULINGS.md` PR 4, "widen"): a client's logo may be a JPEG or a
-- WebP as well as a PNG or an SVG.
--
-- ## What it changes
--
-- **`client_logo_assets.content_type`** (0068) — the CHECK widens from `image/png`, `image/svg+xml` to those two plus
-- `image/jpeg` and `image/webp`. The command checks each file's own signature before it is stored (PNG's, JPEG's
-- `FF D8 FF`, WebP's `RIFF…WEBP`, and the SVG safety check unchanged); this CHECK is the backstop on the type label.
-- Same constraint name, so nothing else that names it changes.
--
-- ## What it does not change
--
-- - **The organisation's own logo** (0142, `organisation_logo_assets`) stays PNG or SVG: the ruling widened the client
--   logo only.
-- - The size cap (256 KB), the append-only grants, and every existing row (all PNG or SVG, so all still pass).

BEGIN;

ALTER TABLE nzi_console.client_logo_assets DROP CONSTRAINT client_logo_assets_content_type_check;
ALTER TABLE nzi_console.client_logo_assets ADD CONSTRAINT client_logo_assets_content_type_check
  CHECK (content_type IN ('image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'));

COMMIT;
