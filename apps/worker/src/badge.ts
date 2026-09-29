// Status badges: embeddable SVG shields, public by design (readmes).

export function badgeLabel(status: string | null): string {
  if (status === "success") return "passing";
  if (status === "failure" || status === "error") return "failing";
  if (status === "running") return "running";
  if (status === "queued" || status === "blocked") return "pending";
  if (status === "cancelled" || status === "skipped") return "skipped";
  return "unknown";
}

export function badgeColor(status: string | null): string {
  if (status === "success") return "#15803d";
  if (status === "failure" || status === "error") return "#dc2626";
  if (status === "running" || status === "queued" || status === "blocked") return "#d97706";
  return "#687182";
}

export function badgeSvg(status: string | null): string {
  const label = badgeLabel(status);
  const color = badgeColor(status);
  const labelWidth = 34 + label.length * 6;
  const total = 62 + labelWidth;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="flare: ${label}">` +
    `<title>flare: ${label}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<rect rx="3" width="${total}" height="20" fill="#555"/>` +
    `<rect rx="3" x="62" width="${labelWidth}" height="20" fill="${color}"/>` +
    `<rect rx="3" width="${total}" height="20" fill="url(#s)"/>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11">` +
    `<text x="31" y="15" fill="#010101" fill-opacity=".3">flare</text><text x="31" y="14">flare</text>` +
    `<text x="${62 + labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>` +
    `<text x="${62 + labelWidth / 2}" y="14">${label}</text></g></svg>`
  );
}
