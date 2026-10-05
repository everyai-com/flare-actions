// Interactive API reference at GET /docs: Redoc renders the served
// openapi.yaml (relative URL, same origin — no CORS, no interpolation,
// nothing to escape). Pure markup; the only runtime dependency is the
// Redoc CDN bundle in the viewer's browser.
export function apiDocsPage(): string {
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Flare Actions API</title>` +
    `<style>body{margin:0;padding:0}</style></head><body>` +
    `<redoc spec-url="openapi.yaml"></redoc>` +
    `<script src="https://cdn.jsdelivr.net/npm/redoc@2/bundles/redoc.standalone.js"></script>` +
    `</body></html>`
  );
}
