/**
 * Compose .npmrc content for a private registry.
 *
 * npm keys auth by the registry's origin+path with no scheme and a trailing
 * slash — `//host/path/:_authToken=…`. With a scope, the registry is bound to
 * that scope only; without one it becomes the default registry.
 */
export function buildNpmrcContent(url: string, scope: string | null | undefined, token: string): string {
    const parsed = new URL(url);
    const pathname = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
    const authKey = `//${parsed.host}${pathname}`;
    const registryLine = scope
        ? `${scope}:registry=${parsed.origin}${pathname}`
        : `registry=${parsed.origin}${pathname}`;
    return `${registryLine}\n${authKey}:_authToken=${token}\n`;
}

/** Replace every literal occurrence of the token with *** for log output. */
export function maskToken(text: string, token: string): string {
    if (!token) return text;
    return text.split(token).join('***');
}
