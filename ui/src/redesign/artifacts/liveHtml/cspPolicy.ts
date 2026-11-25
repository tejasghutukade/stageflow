export type LiveHtmlCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

function policyList(values: readonly string[] | undefined, empty: string): string {
  const items = [...new Set(values ?? [])].sort();
  if (items.length === 0) return empty;
  return items.join(" ");
}

function withPrefix(prefix: string, rest: string): string {
  return rest.length > 0 ? `${prefix} ${rest}` : prefix;
}

/** Same policy string as `buildHtmlCsp` / `artifactDocumentCsp`. Those modules import Node. */
export function liveHtmlDocumentCsp(csp: LiveHtmlCsp): string {
  const resource = policyList(csp.resourceDomains, "");
  return [
    "default-src 'none'",
    `script-src ${withPrefix("'unsafe-inline'", resource)}`,
    `style-src ${withPrefix("'unsafe-inline'", resource)}`,
    `img-src ${withPrefix("data:", resource)}`,
    `font-src ${withPrefix("data:", resource)}`,
    `media-src ${withPrefix("data:", resource)}`,
    `connect-src ${policyList(csp.connectDomains, "'none'")}`,
    "frame-src 'none'",
    `base-uri ${policyList(csp.baseUriDomains, "'none'")}`,
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}
