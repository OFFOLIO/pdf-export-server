const { RequestPolicy, parseAllowedOrigins } = require('../../src/utils/requestPolicy.js');
const { buildChromiumArgs } = require('../../src/config/chromium.js');
const { applyEnv } = require('../../src/config/env.js');
const { config : appConfig } = require('../../app.config.js');

describe('parseAllowedOrigins', () => {
    test('accepts comma or space separated http(s) origins and drops paths', () => {
        expect(parseAllowedOrigins('https://ppm.example.com/app/, http://localhost:8080 https://b.example.com').origins)
            .toEqual(['https://ppm.example.com', 'http://localhost:8080', 'https://b.example.com']);
    });

    test('reports wildcards, other schemes and credentials as invalid', () => {
        const { origins, invalid } = parseAllowedOrigins(['*', 'https://*.example.com', 'file:///etc', 'https://u:p@a.example.com', 'nope']);
        expect(origins).toEqual([]);
        expect(invalid).toHaveLength(5);
    });

    test('empty or missing value allows nothing', () => {
        expect(parseAllowedOrigins(null).origins).toEqual([]);
        expect(parseAllowedOrigins('').origins).toEqual([]);
    });
});

describe('RequestPolicy', () => {
    const policy = new RequestPolicy({ allowedOrigins : 'https://ppm.example.com' });

    policy.addResourcesPort('http', 8080);

    test.each([
        'https://ppm.example.com/static/app.css',
        'https://ppm.example.com/fonts/a.woff2?v=1',
        'data:font/woff2;base64,AAAA',
        'blob:https://ppm.example.com/1234',
        'about:blank',
        'http://localhost:8080/resources/build/grid.css',
        'http://127.0.0.1:8080/resources/a.png'
    ])('allows %s', url => {
        expect(policy.allows(url)).toBe(true);
    });

    test.each([
        'http://ppm.example.com/static/app.css',              // other scheme
        'https://ppm.example.com:8443/static/app.css',        // other port of the allowed host
        'https://evil.example.com/',                          // other host
        'https://ppm.example.com.evil.net/',                  // suffix trick
        'http://169.254.169.254/latest/meta-data/',           // cloud metadata
        'http://pda-be:8082/actuator/env',                    // cluster service
        'http://10.0.0.1/',
        'http://localhost:8080/',                             // own server outside /resources/
        'http://localhost:8080/metrics',
        'http://localhost:8081/resources/a.css',              // other port
        'ws://ppm.example.com/socket',
        'wss://ppm.example.com/socket',
        'file:///etc/passwd',
        'ftp://ppm.example.com/',
        'javascript:alert(1)',
        'chrome://settings',
        'not a url'
    ])('blocks %s', url => {
        expect(policy.allows(url)).toBe(false);
    });

    test('clientURL is only opened when allowed', () => {
        expect(policy.allowsClientURL('https://ppm.example.com/')).toBe(true);
        expect(policy.allowsClientURL('http://localhost:8080/resources/build/grid.css')).toBe(true);
        expect(policy.allowsClientURL('http://pda-be:8082/')).toBe(false);
        expect(policy.allowsClientURL('https://ppm.example.com:444/')).toBe(false);
        expect(policy.allowsClientURL('data:text/html,<h1>x</h1>')).toBe(false);
        expect(policy.allowsClientURL('')).toBe(false);
    });

    test('a policy without configuration allows only inline content', () => {
        const empty = new RequestPolicy();
        expect(empty.allows('data:image/png;base64,AAAA')).toBe(true);
        expect(empty.allows('https://ppm.example.com/app.css')).toBe(false);
        expect(empty.allowsClientURL('https://ppm.example.com/')).toBe(false);
    });
});

describe('secure defaults', () => {
    test('--disable-web-security is off by default', () => {
        expect(appConfig['disable-web-security']).toBe(false);
        expect(buildChromiumArgs(appConfig)).not.toContain('--disable-web-security');
    });

    test('allowed-origins is empty by default and read from PDF_EXPORT_ALLOWED_ORIGINS', () => {
        expect(appConfig['allowed-origins']).toBeNull();
        expect(applyEnv({}, { PDF_EXPORT_ALLOWED_ORIGINS : 'https://ppm.example.com' })['allowed-origins'])
            .toBe('https://ppm.example.com');
    });
});
