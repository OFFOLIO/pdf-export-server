const { CHROMIUM_CRASH_RE } = require('../../src/queue.js');

describe('CHROMIUM_CRASH_RE', () => {
    test.each([
        'Page crashed!',
        'Protocol error (Runtime.callFunctionOn): Target closed',
        'Navigation failed because browser has disconnected!',
    ])('matches Chromium crash message: %s', (message) => {
        expect(CHROMIUM_CRASH_RE.test(message)).toBe(true);
    });

    test.each([
        'Navigation timeout of 120000 ms exceeded',
        'Testing exception',
    ])('does not match non-crash message: %s', (message) => {
        expect(CHROMIUM_CRASH_RE.test(message)).toBe(false);
    });
});
