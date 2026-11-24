// Decides which URLs the headless browser may load while rendering an export. The exported HTML comes from the
// caller, so without this any <iframe>, <img>, <link> or CSS url() in it could make the server fetch (and render
// into the PDF) internal URLs. Only these are allowed:
//  - data:, blob: and about:blank
//  - URLs whose origin (scheme + host + port) is one of the configured `allowed-origins`
//  - the server's own /resources/ path on its loopback origins, when `resources` is configured
// Everything else is aborted, including redirects to another origin (each hop is checked again).
// The clientURL sent by the caller is only navigated to when it is allowed by the same rules.

const RESOURCES_PATH = '/resources/';

function normalizeOrigin(value) {
    let url;

    try {
        url = new URL(String(value).trim());
    }
    catch (e) {
        return null;
    }

    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
        return null;
    }

    return url.origin;
}

/**
 * Parses the `allowed-origins` option: an array or a comma / whitespace separated string of http(s) origins,
 * e.g. "https://ppm.example.com, https://ppm2.example.com". Paths are ignored, entries that are not http(s) URLs
 * (wildcards included) are returned in `invalid` and ignored.
 * @param {String|String[]} value
 * @returns {{ origins : String[], invalid : String[] }}
 */
function parseAllowedOrigins(value) {
    const
        entries = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/),
        origins = new Set(),
        invalid = [];

    for (const entry of entries) {
        if (!entry || !String(entry).trim()) {
            continue;
        }

        const origin = normalizeOrigin(entry);

        if (origin && !/\*/.test(entry)) {
            origins.add(origin);
        }
        else {
            invalid.push(String(entry));
        }
    }

    return { origins : [...origins], invalid };
}

class RequestPolicy {
    /**
     * @param {Object} [config]
     * @param {String|String[]} [config.allowedOrigins]
     */
    constructor({ allowedOrigins } = {}) {
        const { origins, invalid } = parseAllowedOrigins(allowedOrigins);

        this.allowedOrigins = new Set(origins);
        this.invalidOrigins = invalid;
        this.resourcesOrigins = new Set();
    }

    /**
     * Allows `<protocol>://localhost:<port>/resources/` and `<protocol>://127.0.0.1:<port>/resources/` (the
     * server's own static resources). Called by the web server once it listens, only when `resources` is set.
     */
    addResourcesPort(protocol, port) {
        for (const host of ['localhost', '127.0.0.1']) {
            this.resourcesOrigins.add(`${protocol}://${host}:${port}`);
        }
    }

    /**
     * True when the caller's clientURL may be opened before the content is set.
     */
    allowsClientURL(clientURL) {
        return Boolean(clientURL) && /^https?:/i.test(clientURL) && this.allows(clientURL);
    }

    /**
     * True when the browser may load `url`.
     */
    allows(url) {
        if (url === 'about:blank' || /^(data|blob):/i.test(url)) {
            return true;
        }

        let parsed;

        try {
            parsed = new URL(url);
        }
        catch (e) {
            return false;
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return false;
        }

        if (this.allowedOrigins.has(parsed.origin)) {
            return true;
        }

        return this.resourcesOrigins.has(parsed.origin) && parsed.pathname.startsWith(RESOURCES_PATH);
    }

    /**
     * Turns on request interception for `page`: allowed requests continue, all others are aborted.
     * @param page Puppeteer page
     * @param {Function} [onBlocked] Called with the blocked URL
     */
    async apply(page, onBlocked) {
        await page.setRequestInterception(true);

        page.on('request', request => {
            if (request.isInterceptResolutionHandled()) {
                return;
            }

            const url = request.url();

            if (this.allows(url)) {
                request.continue();
            }
            else {
                if (onBlocked) {
                    onBlocked(url);
                }

                request.abort('blockedbyclient');
            }
        });
    }
}

module.exports = { RequestPolicy, parseAllowedOrigins, normalizeOrigin };
