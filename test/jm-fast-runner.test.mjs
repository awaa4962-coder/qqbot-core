import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";

function findTestPython() {
  if (process.env.QQBOT_TEST_PYTHON && fs.existsSync(process.env.QQBOT_TEST_PYTHON)) {
    return process.env.QQBOT_TEST_PYTHON;
  }
  const bundled = path.join(process.env.USERPROFILE || "", ".cache", "codex-runtimes",
    "codex-primary-runtime", "dependencies", "python", "python.exe");
  if (fs.existsSync(bundled)) return bundled;
  for (const candidate of process.platform === "win32" ? ["python"] : ["python3", "python"]) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0) return candidate;
  }
  return "";
}

const python = findTestPython();
const runnerPath = path.resolve("scripts", "jm_download_once.py");
const harness = String.raw`
import contextlib, importlib.util, io, json, os, sys, tempfile, types
from concurrent.futures import ThreadPoolExecutor

spec = importlib.util.spec_from_file_location("jm_runner", sys.argv[1])
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
output = io.StringIO()
runner.PROTOCOL_STDOUT = output
SECRET = "https://private.invalid/image.jpg?token=SECRET_VALUE Authorization=BEARER_SECRET /private/path"

class FakeOption:
    @staticmethod
    def construct(config):
        return config

class FakeClient:
    def __init__(self, mirrors=5):
        self.domain_list = ["mirror%d.invalid" % i for i in range(mirrors)]
        self.retry_times = 99
        self.api_calls = []
        self.checks = 0
    def request_with_retry(self, request, url, domain_index=0, retry_count=0, is_image=False, **kwargs):
        self.api_calls.append((request, url, domain_index, retry_count, is_image, kwargs))
        return "api-result"
    def update_request_with_specify_domain(self, kwargs, domain, is_image):
        assert domain is None and is_image is True
        kwargs["headers"] = {"Authorization": "BEARER_SECRET"}
    def raise_if_resp_should_retry(self, resp, is_image):
        assert is_image is True
        self.checks += 1
        if resp == "invalid":
            raise ValueError(SECRET)
        return resp

class FakeDownloader:
    def __init__(self, option):
        self.option = option
        self.client = self.create_client()
        self.download_failed_image = []
        self.download_failed_photo = []
        self.all_success = True
    def create_client(self):
        return FakeClient()
    def before_album(self, album):
        pass
    def before_photo(self, photo):
        pass
    def after_image(self, image, img_save_path):
        pass
    def download_by_image_detail(self, image):
        try:
            image.perform(self)
        except Exception as exc:
            self.download_failed_image.append((image, exc))
            raise
    def download_by_photo_detail(self, photo):
        try:
            photo.perform(self)
        except Exception as exc:
            self.download_failed_photo.append((photo, exc))
            raise

class Entity:
    def __init__(self, count):
        self.count = count
        self.name = "PRIVATE_TITLE"
        self.id = "PRIVATE_BOOK_ID"
        self.page_count = 999999
    def __len__(self):
        return self.count

fake_jm = types.ModuleType("jmcomic")
fake_jm.JmOption = FakeOption
fake_jm.JmDownloader = FakeDownloader
fake_jm.download_album = lambda *a, **k: None
sys.modules["jmcomic"] = fake_jm
os.environ["QQBOT_JM_AUTO_INSTALL"] = "0"
os.environ.pop("QQBOT_JMCOMIC_SRC", None)
os.environ.pop("JMCOMIC_SRC", None)

def events():
    return [json.loads(line[len(runner.PROGRESS_PREFIX):]) for line in output.getvalue().splitlines()
            if line.startswith(runner.PROGRESS_PREFIX)]

def run_main(download, *args):
    fake_jm.download_album = download
    output.seek(0)
    output.truncate()
    stray_out, stray_err = io.StringIO(), io.StringIO()
    with tempfile.TemporaryDirectory(prefix="qqfriend-jm-fake-") as directory:
        sys.argv = [sys.argv[1], "--id", "000000000000", "--out", directory, *args]
        with contextlib.redirect_stdout(stray_out), contextlib.redirect_stderr(stray_err):
            code = 0
            try:
                runner.main()
            except SystemExit as exc:
                code = exc.code
    assert stray_out.getvalue() == "", stray_out.getvalue()
    assert stray_err.getvalue() == "", stray_err.getvalue()
    text = output.getvalue()
    results = [json.loads(line[len(runner.RESULT_PREFIX):]) for line in text.splitlines()
               if line.startswith(runner.RESULT_PREFIX)]
    assert len(results) == 1, text
    return code, results[0], events(), text

def scenario(mode):
    def download(book_id, option, check_exception, downloader):
        assert check_exception is True
        dler = downloader(option)
        album = Entity(0 if mode == "empty" else 2)
        if mode != "unknown":
            dler.before_album(album)
        photos = [Entity(2), Entity(2)] if mode != "empty" else []
        if mode == "empty_photo":
            photos = [Entity(0), Entity(2)]
        for photo in photos:
            dler.before_photo(photo)
        for index in range(sum(len(photo) for photo in photos)):
            if mode == "short" and index == 3:
                continue
            def perform(d, index=index):
                if mode.startswith("partial") and index == 3:
                    print(SECRET)
                    print(SECRET, file=sys.stderr)
                    raise TimeoutError(SECRET)
                filepath = os.path.join(option["dir_rule"]["base_dir"], "%d.jpg" % index)
                with open(filepath, "wb") as image_file:
                    image_file.write(b"" if mode == "zero" and index == 3 else b"img")
                d.after_image(types.SimpleNamespace(), filepath)
            try:
                dler.download_by_image_detail(types.SimpleNamespace(perform=perform))
            except Exception:
                pass
        if mode == "partial_raise":
            raise RuntimeError(SECRET)
        if mode == "false_flag":
            dler.all_success = False
        if mode in ("changed_bytes", "extra_file"):
            name = "0.jpg" if mode == "changed_bytes" else "unexpected.txt"
            with open(os.path.join(option["dir_rule"]["base_dir"], name), "wb") as extra:
                extra.write(b"changed")
        return album, dler
    return run_main(download)
`;

function pythonCase(t, code) {
  if (!python) return t.skip("python unavailable");
  const result = spawnSync(python, ["-S", "-B", "-c", harness + "\n" + code, runnerPath], {
    encoding: "utf8", timeout: 20000, windowsHide: true,
    env: { ...process.env, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", QQBOT_JM_AUTO_INSTALL: "0" },
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

describe("JM bounded Python runner (offline synthetic modules)", () => {
  it("records bounded numeric timings without double-counting recursive API retries", t => pythonCase(t, String.raw`
now = [0.0]
timings = runner.DownloadTimings(clock=lambda: now[0])
class RecursiveClient(FakeClient):
    def request_with_retry(self, request, url, domain_index=0, retry_count=0, is_image=False, **kwargs):
        now[0] += 0.01
        if retry_count == 0:
            return self.request_with_retry(request, url, domain_index, 1, is_image, **kwargs)
        return "api-result"
client = runner.bound_image_requests(RecursiveClient(), timings)
assert client.request_with_retry(None, SECRET) == "api-result"
assert timings.snapshot()["metadataCallsCompleted"] == 1
assert timings.snapshot()["metadataMs"] == 20
responses = iter(("invalid", "valid"))
def request(*args, **kwargs):
    now[0] += 0.025
    return next(responses)
assert client.request_with_retry(request, SECRET, is_image=True) == "valid"
snapshot = timings.snapshot()
assert snapshot["imageRequestsCompleted"] == 2 and snapshot["imageRetriesCompleted"] == 1
assert snapshot["imageRequestMs"] == 50 and snapshot["imageRequestMaxMs"] == 25
assert snapshot["observedMs"] == 70
assert all(type(value) is int and value >= 0 for value in snapshot.values())
assert not any(word in json.dumps(snapshot) for word in ("SECRET", "Authorization", "https://"))
`));

  it("closes the per-task transport session after success and failure", t => pythonCase(t, String.raw`
closed = []
original_create = FakeDownloader.create_client
def create(self):
    client = original_create(self)
    client.postman = types.SimpleNamespace(session=types.SimpleNamespace(close=lambda: closed.append(1)))
    return client
FakeDownloader.create_client = create
assert scenario("success")[0] == 0
assert scenario("partial_return")[0] == 1
assert closed == [1, 1]
`));

  it("configures short tuple timeouts, task metadata caching and bounded concurrency", t => pythonCase(t, String.raw`
os.environ["QQBOT_JM_DOMAINS"] = "one.invalid;two.invalid\nthree.invalid"
config = runner.build_option(FakeOption, "/output")
assert config["client"]["postman"]["meta_data"]["timeout"] == (3, 8)
assert config["client"]["postman"]["type"] == "curl_cffi_session"
assert config["client"]["retry_times"] == 1
assert config["client"]["cache"] is True
assert config["download"]["cache"] is False
assert config["download"]["image"]["decode"] is True
assert config["download"]["threading"] == {"image": 12, "photo": 2}
assert config["client"]["domain"] == ["one.invalid", "two.invalid", "three.invalid"]
`));

  it("caps each failed image at two attempts independent of API mirror count without class patches", t => pythonCase(t, String.raw`
original = FakeClient.request_with_retry
for mirrors in (1, 4, 20):
    client = runner.bound_image_requests(FakeClient(mirrors))
    calls = []
    def fail(url, **kwargs):
        calls.append((url, kwargs))
        raise TimeoutError(SECRET)
    try:
        client.request_with_retry(fail, SECRET, is_image=True, timeout=None)
        assert False
    except TimeoutError:
        pass
    assert len(calls) == 2
    assert all(url == SECRET and kw["timeout"] == (3, 8) for url, kw in calls)
    assert client.api_calls == [] and client.retry_times == 99
    assert len(client.domain_list) == mirrors
assert FakeClient.request_with_retry is original
assert FakeClient().request_with_retry(None, "/album") == "api-result"
`));

  it("retains response validation and can recover on its single image retry", t => pythonCase(t, String.raw`
client = runner.bound_image_requests(FakeClient())
responses = iter(("invalid", "valid"))
assert client.request_with_retry(lambda *a, **k: next(responses), SECRET, is_image=True) == "valid"
assert client.checks == 2
client.checks = 0
try:
    client.request_with_retry(lambda *a, **k: "invalid", SECRET, is_image=True)
    assert False
except ValueError:
    pass
assert client.checks == 2
assert client.request_with_retry(None, "/album", 2, 1, False, params={"id": "private"}) == "api-result"
assert client.api_calls[-1][1:5] == ("/album", 2, 1, False)
`));

  it("does not share per-image retry budgets between concurrent workers", t => pythonCase(t, String.raw`
from threading import Lock
client = runner.bound_image_requests(FakeClient(30))
counts, lock = {}, Lock()
def fail(url, **kwargs):
    with lock:
        counts[url] = counts.get(url, 0) + 1
    raise TimeoutError(SECRET)
def worker(index):
    try:
        client.request_with_retry(fail, str(index), is_image=True)
    except TimeoutError:
        pass
with ThreadPoolExecutor(max_workers=12) as pool:
    list(pool.map(worker, range(40)))
assert len(counts) == 40 and set(counts.values()) == {2}
assert len(client.domain_list) == 30 and client.retry_times == 99
`));

  it("emits throttled numeric progress with real manifest totals and failure counts", t => pythonCase(t, String.raw`
now = [0.0]
p = runner.DownloadProgress(clock=lambda: now[0])
p.publish(force=True)
album, first, second = Entity(2), Entity(2), Entity(1)
p.before_album(album)
p.before_photo(first)
assert p.total is None
with tempfile.TemporaryDirectory() as directory:
    filepath = os.path.join(directory, "PRIVATE_PATH.jpg")
    with open(filepath, "wb") as image_file:
        image_file.write(b"12345")
    for _ in range(50):
        p.after_image(filepath)
    assert len(events()) == 2
    now[0] = 0.51
    p.publish()
    assert events()[-1] == {"phase": "downloading", "completed": 1, "total": None, "bytes": 5, "failed": 0}
    p.before_photo(second)
    assert p.total == 3
    d = types.SimpleNamespace(download_failed_image=[("private", TimeoutError(SECRET))], download_failed_photo=[])
    now[0] = 1.02
    p.refresh_failures(d)
assert events()[-1]["failed"] == 1 and events()[-1]["total"] == 3
for event in events():
    assert set(event) == {"phase", "completed", "total", "bytes", "failed"}
    assert event["phase"] in ("preparing", "downloading")
    for field in ("completed", "bytes", "failed"):
        assert type(event[field]) is int and event[field] >= 0
    assert event["total"] is None or type(event["total"]) is int
assert "PRIVATE" not in output.getvalue() and "SECRET" not in output.getvalue()
`));

  it("keeps threaded progress counts exact and sends no per-image log stream", t => pythonCase(t, String.raw`
p = runner.DownloadProgress(clock=lambda: 0)
p.publish(force=True)
with tempfile.TemporaryDirectory() as directory:
    paths = [os.path.join(directory, "%d.jpg" % i) for i in range(120)]
    for filepath in paths:
        with open(filepath, "wb") as image_file:
            image_file.write(b"img")
    with ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(p.after_image, paths))
assert p.completed == 120 and p.bytes == 360 and p.total is None
assert len(events()) == 1
`));

  it("emits success only for a complete nonempty download", t => pythonCase(t, String.raw`
code, result, progress, text = scenario("success")
assert code == 0 and result["ok"] is True and result["all_success"] is True
assert result["files"] == 4 and result["bytes"] == 12
assert {k:v for k,v in progress[-1].items() if k != "timings"} == {"phase": "preparing", "completed": 4, "total": 4, "bytes": 12, "failed": 0}
assert result["timings"]["firstImageMs"] <= result["timings"]["lastImageMs"] <= result["timings"]["downloadFinishedMs"]
assert all("PRIVATE" not in json.dumps(event) for event in progress)
`));

  it("rejects empty, missing, unknown, zero-byte and library-incomplete outputs", t => pythonCase(t, String.raw`
for mode in ("empty", "empty_photo", "short", "unknown", "zero", "false_flag", "changed_bytes", "extra_file"):
    code, result, progress, text = scenario(mode)
    assert code == 1 and result["ok"] is False and result["all_success"] is False, (mode, result)
    assert result["error_category"] == "incomplete"
    if mode == "zero":
        assert result["failed_images"] == 1 and progress[-1]["failed"] == 1
    if mode == "unknown":
        assert progress[-1]["total"] is None
    assert "PRIVATE" not in text and "SECRET" not in text
`));

  it("reports callback failures even if the library raises or incorrectly returns success", t => pythonCase(t, String.raw`
for mode in ("partial_raise", "partial_return"):
    code, result, progress, text = scenario(mode)
    assert code == 1 and result["ok"] is False and result["all_success"] is False
    assert result["failed"] == result["failed_images"] == 1 and result["failed_photos"] == 0
    assert progress[-1]["completed"] == 3 and progress[-1]["total"] == 4 and progress[-1]["failed"] == 1
    assert result["error"] == "JM download failed or is incomplete."
    assert all(private not in text for private in ("https://", "SECRET", "PRIVATE", "Authorization", "Traceback"))
`));

  it("tracks a failed chapter through the real downloader method boundary", t => pythonCase(t, String.raw`
def download(book_id, option, check_exception, downloader):
    d = downloader(option)
    album, photo = Entity(1), Entity(1)
    d.before_album(album)
    def fail(dler):
        raise OSError(SECRET)
    photo.perform = fail
    try:
        d.download_by_photo_detail(photo)
    except OSError:
        pass
    return album, d
code, result, progress, text = run_main(download)
assert code == 1 and result["failed_photos"] == 1 and result["failed_images"] == 0
assert progress[-1]["failed"] == 1 and progress[-1]["total"] is None
assert "SECRET" not in text
`));

  it("sanitizes errors and dependency logs without emitting raw exception classes", t => pythonCase(t, String.raw`
def download(*args, **kwargs):
    print(SECRET)
    print(SECRET, file=sys.stderr)
    raise TimeoutError(SECRET)
code, result, progress, text = run_main(download)
assert code == 1 and result["error_category"] == "timeout"
assert result["failed"] == 0 and result["all_success"] is False
assert all(private not in text for private in ("https://", "SECRET", "Authorization", "Traceback", "/private/path"))
`));

  it("never installs while downloading, but keeps explicit --check installation compatible", t => pythonCase(t, String.raw`
os.environ["QQBOT_JM_AUTO_INSTALL"] = "1"
attempts, installs = [], []
def load():
    attempts.append(1)
    if not installs:
        print(SECRET)
        raise ImportError(SECRET)
    return FakeOption, fake_jm.download_album
runner.load_jmcomic = load
runner.install_jm_dependencies = lambda: installs.append(1)
code, result, progress, text = run_main(fake_jm.download_album)
assert code == 2 and installs == [] and result["ok"] is False
assert result["error_category"] == "dependency"
assert "SECRET" not in text and "https://" not in text
code, result, progress, text = run_main(fake_jm.download_album, "--check")
assert code == 0 and installs == [1] and result["reason"] == "runtime_ok"
`));

  it("pins fallback dependencies and suppresses installer stdout and stderr", t => pythonCase(t, String.raw`
runner.JM_REQUIREMENTS_FILE = os.path.join(tempfile.gettempdir(), "qqfriend-absent-requirements.txt")
commands = []
runner.subprocess.check_call = lambda command, **kwargs: commands.append((command, kwargs))
runner.install_jm_dependencies()
command, kwargs = commands[0]
assert "jmcomic==2.7.4" in command and "curl_cffi==0.16.0" in command
assert kwargs == {"stdout": runner.subprocess.DEVNULL, "stderr": runner.subprocess.DEVNULL}
`));
});
