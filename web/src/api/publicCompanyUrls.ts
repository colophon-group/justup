// Browser-safe company metadata URLs. Syntactic URL safety never establishes career-page approval.
const NONPUBLIC_SUFFIX = /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|home|lan|test|invalid|example|private|corp|onion|arpa)$/i;
export function safePublicCompanyURL(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f-\u009f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.port || host.length > 253 || NONPUBLIC_SUFFIX.test(host)
      || !/^[a-z0-9.-]+\.(?:[a-z]{2,}|xn--[a-z0-9-]{2,})$/i.test(host)
      || host.split('.').some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return null;
    return url.href;
  } catch { return null; }
}
export function safePublicCompanyDomain(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[a-z0-9.-]+$/i.test(value)) return null;
  const url = safePublicCompanyURL(`https://${value}/`);
  return url && new URL(url).hostname === value.toLowerCase() ? value.toLowerCase() : null;
}
