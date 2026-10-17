import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import test from "node:test";

const benchmark = String.raw`
import copy, importlib.metadata, importlib.util, json, os, socket, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import urlsplit

for key in list(os.environ):
    if key.lower().endswith('_proxy') or key in ('REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSLKEYLOGFILE'):
        os.environ.pop(key, None)
os.environ['QQBOT_JM_AUTO_INSTALL'] = '0'
os.environ['QQBOT_JM_DOMAINS'] = ''

def local(host):
    assert host in ('127.0.0.1', 'localhost', b'127.0.0.1', b'localhost'), 'non-loopback socket/DNS blocked'

original_dns, original_connect, original_bind = socket.getaddrinfo, socket.socket.connect, socket.socket.bind
def dns(host, *args, **kwargs):
    local(host)
    return original_dns('127.0.0.1', *args, **kwargs)
def connect(sock, address):
    local(address[0])
    return original_connect(sock, address)
def bind(sock, address):
    local(address[0])
    return original_bind(sock, address)

socket.getaddrinfo = dns
socket.gethostbyname = lambda host: (local(host), '127.0.0.1')[1]
socket.gethostbyname_ex = lambda host: (local(host), ('localhost', [], ['127.0.0.1']))[1]
socket.gethostbyaddr = lambda host: (local(host), ('localhost', [], ['127.0.0.1']))[1]
socket.socket.connect = connect
socket.socket.connect_ex = lambda sock, address: (connect(sock, address), 0)[1]
socket.socket.bind = bind
try:
    import curl_cffi
except ImportError:
    print(json.dumps({'status': 'optional_skip', 'reason': 'curl_cffi unavailable'}))
    raise SystemExit(77)
from common import Postmans
from curl_cffi import CurlHttpVersion, CurlOpt, requests
versions = {name: importlib.metadata.version(name) for name in ('commonX', 'curl_cffi')}
assert versions == {'commonX': '0.6.40', 'curl_cffi': '0.16.0'}, 'benchmark dependency versions differ'

spec = importlib.util.spec_from_file_location('jm_transport_runner', sys.argv[1])
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
class Option:
    @staticmethod
    def construct(config): return config
config = runner.build_option(Option, '/synthetic-unused-output')
assert config['download']['threading'] == {'image': 12, 'photo': 2}
new_config = config['client']['postman']
assert new_config['type'] == 'curl_cffi_session'
meta = new_config['meta_data']
assert meta['timeout'] == (3, 8) and meta['impersonate'] == 'chrome'
assert meta['headers'] is None and meta['proxies'] is None
payload = b'synthetic-image-bytes-' * 1024
baseline_threads = set(threading.enumerate())

class Server(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True
    def __init__(self):
        self.guard = threading.Lock()
        self.connections, self.requests, self.cookie_retained = 0, 0, False
        self.sockets = set()
        super().__init__(('127.0.0.1', 0), Handler)
    def get_request(self):
        sock, address = super().get_request()
        assert address[0] == '127.0.0.1'
        sock.settimeout(8)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        with self.guard:
            self.connections += 1
            self.sockets.add(sock)
        return sock, address
    def process_request_thread(self, request, address):
        try: super().process_request_thread(request, address)
        finally:
            with self.guard: self.sockets.discard(request)
    def handle_error(self, *_args):
        self.failed = True
    def disconnect_all(self):
        with self.guard: active = list(self.sockets)
        for sock in active:
            try: sock.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            sock.close()

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_args): pass
    def do_GET(self):
        assert self.request_version == 'HTTP/1.1'
        assert self.path.startswith(('/meta/', '/image/'))
        with self.server.guard:
            self.server.requests += 1
            if self.path == '/meta/1':
                self.server.cookie_retained = 'jm_transport=synthetic' in self.headers.get('Cookie', '')
        self.send_response(200)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Connection', 'keep-alive')
        if self.path == '/meta/0': self.send_header('Set-Cookie', 'jm_transport=synthetic; Path=/; HttpOnly')
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()

def run_case(postman_config):
    server = Server()
    serving = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.02}, name='jm-loopback-server')
    postman, sessions = None, []
    original_init, original_request = requests.Session.__init__, requests.Session.request
    origin = 'http://127.0.0.1:' + str(server.server_port)
    def session_init(session, *args, **kwargs):
        # The old module-level API cannot take trust_env per request; both real constructors enforce it.
        kwargs['trust_env'] = False
        original_init(session, *args, **kwargs)
        sessions.append(session)
    def request(session, method, url, *args, **kwargs):
        parsed = urlsplit(url)
        assert parsed.scheme == 'http' and parsed.hostname == '127.0.0.1' and parsed.port == server.server_port
        assert not parsed.username and not parsed.password and session.trust_env is False
        assert kwargs.get('timeout', session.timeout) == (3, 8)
        return original_request(session, method, url, *args, **kwargs)
    data = copy.deepcopy(postman_config)
    data['meta_data'].update(http_version=CurlHttpVersion.V1_1, allow_redirects=False,
        curl_options={CurlOpt.PROXY: b''})
    # curl_cffi still uses C sockets: pin numeric URLs, disable redirects, and explicitly disable libcurl proxies too.
    data['meta_data'].pop('trust_env', None)
    serving.start()
    started = time.perf_counter()
    try:
        with patch.object(requests.Session, '__init__', session_init), patch.object(requests.Session, 'request', request):
            postman = Postmans.create(data=data)
            session = getattr(postman, 'session', None)
            def get(route):
                response = postman.get(origin + route)
                try:
                    assert response.status_code == 200 and response.content == payload
                finally: response.close()
            for index in range(3): get('/meta/' + str(index))
            metadata_ms = round((time.perf_counter() - started) * 1000, 3)
            metadata_connections = server.connections
            images_started = time.perf_counter()
            barrier = threading.Barrier(4)
            def images(worker):
                try:
                    barrier.wait(timeout=3)
                    for index in range(worker * 8, (worker + 1) * 8): get('/image/' + str(index))
                finally:
                    # Session.close only closes the caller's thread-local handle; workers close their own.
                    if session is not None: session.curl.close()
            with ThreadPoolExecutor(max_workers=4, thread_name_prefix='jm-loopback-images') as pool:
                list(pool.map(images, range(4)))
            images_ms = round((time.perf_counter() - images_started) * 1000, 3)
            elapsed = round((time.perf_counter() - started) * 1000, 3)
    finally:
        if postman is not None and getattr(postman, 'session', None) is not None: postman.session.close()
        server.shutdown()
        serving.join(timeout=2)
        server.disconnect_all()
        server.server_close()
        assert not serving.is_alive() and not server.sockets, 'loopback server cleanup incomplete'
        assert all(session._closed for session in sessions), 'real curl session was not closed'
    assert not getattr(server, 'failed', False) and server.requests == 35
    assert not [thread for thread in threading.enumerate() if thread not in baseline_threads], 'benchmark thread leaked'
    return {'transport': data['type'], 'totalMs': elapsed, 'tcpConnections': server.connections,
            'metadataMs': metadata_ms, 'metadataConnections': metadata_connections,
            'imagesMs': images_ms, 'imageConnections': server.connections - metadata_connections,
            'requests': server.requests, 'syntheticCookieRetained': server.cookie_retained}

old_config = copy.deepcopy(new_config)
old_config['type'] = 'curl_cffi'
old = run_case(old_config)
new = run_case(new_config)
assert old['tcpConnections'] == 35, 'old transport must open one TCP connection per request'
assert old['metadataConnections'] == 3 and new['metadataConnections'] == 1
assert old['imageConnections'] == 32 and 1 <= new['imageConnections'] <= 4
assert 1 <= new['tcpConnections'] <= 5, 'session transport must reuse at most one main + four worker connections'
assert not old['syntheticCookieRetained'] and new['syntheticCookieRetained'], 'synthetic session cookie did not persist'
print(json.dumps({'status': 'passed', 'benchmark': 'controlled_http11_connection_cost_not_cdn_speedup',
    'versions': versions, 'serialMetadata': 3, 'images': 32, 'imageWorkers': 4,
    'old': old, 'new': new, 'cleanupComplete': True}, separators=(',', ':')))
`;

test("real Postmans controlled HTTP/1.1 connection cost and synthetic session cookies (not CDN speedup)", { timeout: 20000 }, t => {
  const started = performance.now();
  let python = process.env.QQBOT_TEST_PYTHON || "";
  if (!python) {
    for (const candidate of process.platform === "win32" ? ["python"] : ["python3", "python"]) {
      if (spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 1000, windowsHide: true }).status === 0) {
        python = candidate;
        break;
      }
    }
  }
  const required = process.platform === "linux" && Boolean(process.env.CI);
  if (!python) {
    assert.equal(required, false, "Linux CI must run the real installed transport benchmark");
    return t.skip("optional transport benchmark: Python unavailable");
  }
  const result = spawnSync(python, ["-I", "-B", "-c", benchmark, path.resolve("scripts", "jm_download_once.py")], {
    encoding: "utf8", windowsHide: true, timeout: Math.max(1, Math.min(18000, 20000 - (performance.now() - started))),
    maxBuffer: 128 * 1024,
    env: { ...process.env, QQBOT_JM_AUTO_INSTALL: "0", QQBOT_JM_DOMAINS: "", PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.error, undefined, result.error?.code || "Python benchmark could not finish within its bounded lifetime");
  if (result.status === 77) {
    assert.equal(required, false, "Linux CI must install curl_cffi and run this benchmark, not skip it");
    return t.skip("optional transport benchmark: curl_cffi unavailable");
  }
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.status, "passed");
  assert.equal(report.old.tcpConnections, 35);
  assert.ok(report.new.tcpConnections <= 5);
  assert.equal(report.new.syntheticCookieRetained, true);
  assert.equal(report.cleanupComplete, true);
  t.diagnostic(JSON.stringify(report));
});
