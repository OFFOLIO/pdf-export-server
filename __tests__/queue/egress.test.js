// Exported HTML comes from the caller. It must not be able to make the server load URLs outside allowed-origins
// (cluster services, metadata endpoints, other ports of an allowed host), directly or through a redirect.
const http = require('http');
const { createExportServer, stopExportServer, streamToBuffer, getLoggerConfig } = require('../utils.js');

jest.setTimeout(60 * 1000);

function startCountingServer(handler) {
    const server = http.createServer((req, res) => {
        server.hits.push(req.url);
        handler(req, res);
    });

    server.hits = [];
    // WebSocket handshakes arrive as 'upgrade', not as requests
    server.on('upgrade', (req, socket) => {
        server.hits.push(`upgrade ${req.url}`);
        socket.destroy();
    });

    return new Promise(resolve => server.listen(0, () => resolve(server)));
}

function stopCountingServer(server) {
    return new Promise(resolve => server ? server.close(resolve) : resolve());
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

let internal, app, exportServer;

beforeAll(async() => {
    // Stands for a cluster-internal service: every hit on it is a leak
    internal = await startCountingServer((req, res) => {
        res.writeHead(200, { 'Content-Type' : 'text/html' });
        res.end('<h1>INTERNAL-CANARY-SECRET</h1>');
    });

    // Stands for the frontend (the allowed origin)
    app = await startCountingServer((req, res) => {
        if (req.url === '/redirect.css') {
            res.writeHead(302, { Location : `http://127.0.0.1:${internal.address().port}/redirected.css` });
            res.end();
        }
        else if (req.url === '/app.css') {
            res.writeHead(200, { 'Content-Type' : 'text/css' });
            res.end('.b-export-content { color: #123456; }');
        }
        else {
            res.writeHead(200, { 'Content-Type' : 'text/html' });
            res.end('<!doctype html><html><body></body></html>');
        }
    });
});

afterAll(async() => {
    await stopCountingServer(internal);
    await stopCountingServer(app);
});

beforeEach(() => {
    internal.hits.length = 0;
    app.hits.length = 0;
});

afterEach(() => {
    if (exportServer) {
        stopExportServer(exportServer);
        exportServer = null;
    }
});

function appOrigin() {
    return `http://localhost:${app.address().port}`;
}

function hostileHTML() {
    const
        port        = internal.address().port,
        byIp        = `http://127.0.0.1:${port}`,
        // Same host name as the allowed origin, other port
        sameHost    = `http://localhost:${port}`;

    return `<!doctype html>
<html>
<head>
    <link rel="stylesheet" href="${appOrigin()}/app.css">
    <link rel="stylesheet" href="${appOrigin()}/redirect.css">
    <link rel="stylesheet" href="${byIp}/link.css">
    <link rel="prefetch" href="${byIp}/prefetch">
    <style>
        @import url("${byIp}/import.css");
        body { background-image: url("${sameHost}/background.png"); }
        @font-face { font-family: leak; src: url("${byIp}/font.woff2"); }
        h1 { font-family: leak; }
    </style>
</head>
<body>
    <div class="b-export-content"><h1>Export</h1></div>
    <img src="${byIp}/img.png">
    <img src="${sameHost}/img-same-host.png">
    <iframe src="${byIp}/frame"></iframe>
    <iframe src="${sameHost}/frame-same-host"></iframe>
    <object data="${byIp}/object"></object>
    <video poster="${byIp}/poster.png"></video>
    <script>
        fetch('${byIp}/fetch');
        new WebSocket('ws://127.0.0.1:${port}/ws');
        document.write('<img src="${byIp}/script-img.png">');
    </script>
</body>
</html>`;
}

async function exportPdf({ allowedOrigins, clientURL, html = hostileHTML(), fileFormat = 'pdf', name }) {
    exportServer = createExportServer({
        workers : 1,
        allowedOrigins,
        logger  : getLoggerConfig(name)
    });

    const result = await exportServer.exportRequestHandler({
        html        : [{ html }],
        orientation : 'portrait',
        format      : 'A4',
        fileFormat,
        clientURL
    }, `egress-${name}`);

    const buffer = await streamToBuffer(result);

    // Let any late request reach the servers before counting
    await wait(500);

    return buffer;
}

describe('Export page egress', () => {
    test('internal URLs in the HTML are not fetched, allowed resources still load (PDF)', async() => {
        const buffer = await exportPdf({ allowedOrigins : appOrigin(), clientURL : `${appOrigin()}/`, name : 'egress_pdf' });

        expect(buffer.slice(0, 4).toString('utf8')).toBe('%PDF');
        expect(internal.hits).toEqual([]);
        // Normal export: the clientURL page and the stylesheet on the allowed origin were loaded
        expect(app.hits).toEqual(expect.arrayContaining(['/', '/app.css', '/redirect.css']));
    });

    test('internal URLs in the HTML are not fetched (PNG)', async() => {
        const buffer = await exportPdf({ allowedOrigins : appOrigin(), clientURL : `${appOrigin()}/`, fileFormat : 'png', name : 'egress_png' });

        expect(buffer.slice(1, 4).toString('utf8')).toBe('PNG');
        expect(internal.hits).toEqual([]);
        expect(app.hits).toEqual(expect.arrayContaining(['/app.css']));
    });

    test('a clientURL outside allowed-origins is not opened, the export still works', async() => {
        const buffer = await exportPdf({
            allowedOrigins : appOrigin(),
            clientURL      : `http://127.0.0.1:${internal.address().port}/client`,
            html           : `<html><head><link rel="stylesheet" href="${appOrigin()}/app.css"></head><body><div class="b-export-content">ok</div></body></html>`,
            name           : 'egress_client_url'
        });

        expect(buffer.slice(0, 4).toString('utf8')).toBe('%PDF');
        expect(internal.hits).toEqual([]);
        // (The page starts from about:blank, from where Chrome itself refuses loopback stylesheets, so the
        // test servers on localhost cannot prove the stylesheet load here; the first test covers it.)
    });

    test('without allowed-origins nothing external is loaded', async() => {
        const buffer = await exportPdf({ allowedOrigins : null, clientURL : `${appOrigin()}/`, name : 'egress_empty' });

        expect(buffer.slice(0, 4).toString('utf8')).toBe('%PDF');
        expect(internal.hits).toEqual([]);
        expect(app.hits).toEqual([]);
    });

    test('control: the counting server does see requests when its origin is allowed', async() => {
        await exportPdf({
            allowedOrigins : `${appOrigin()},http://127.0.0.1:${internal.address().port}`,
            clientURL      : `${appOrigin()}/`,
            name           : 'egress_control'
        });

        expect(internal.hits).toEqual(expect.arrayContaining(['/link.css', '/img.png', '/redirected.css']));
        // JavaScript stays disabled: no script-driven request even to an allowed origin
        expect(internal.hits).not.toEqual(expect.arrayContaining(['/fetch']));
        expect(internal.hits.filter(hit => hit.startsWith('upgrade'))).toEqual([]);
        expect(internal.hits).not.toContain('/script-img.png');
    });
});
