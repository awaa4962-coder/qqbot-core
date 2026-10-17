import argparse
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import json
import os
import subprocess
import sys
from threading import Lock, local
import time
from types import MethodType

RESULT_PREFIX = "QQFRIEND_JM_RESULT "
PROGRESS_PREFIX = "QQFRIEND_JM_PROGRESS "
PROTOCOL_STDOUT = sys.stdout
REQUEST_TIMEOUT = (3, 8)
IMAGE_ATTEMPTS = 2
JM_DEPENDENCIES = [
    "jmcomic==2.7.4",
    "curl_cffi==0.16.0",
    "commonX==0.6.40",
    "PyYAML==6.0.3",
    "Pillow==12.3.0",
    "pycryptodome==3.23.0",
]
JM_REQUIREMENTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "requirements-jm.txt")
JM_REQUIRED_SOURCE_FILES = [
    "jm_config.py",
    "jm_plugin.py",
    "jm_feature.py",
    "jm_async_client.py",
    "jm_async_downloader.py",
]


def emit(payload):
    print(RESULT_PREFIX + json.dumps(payload, ensure_ascii=False), file=PROTOCOL_STDOUT, flush=True)


@contextmanager
def quiet_dependencies():
    # Worker-thread tracebacks and dependency logs may contain signed URLs.
    with open(os.devnull, "w") as sink, redirect_stdout(sink), redirect_stderr(sink):
        yield


def jm_source_status():
    src = os.environ.get("QQBOT_JMCOMIC_SRC") or os.environ.get("JMCOMIC_SRC")
    if not src:
        return {"path": "", "usable": False, "reason": "not_configured", "missing": []}
    package_dir = os.path.join(src, "jmcomic")
    if not os.path.isdir(package_dir):
        return {"path": src, "usable": False, "reason": "source_missing", "missing": ["jmcomic/"]}
    missing = [
        name for name in JM_REQUIRED_SOURCE_FILES
        if not os.path.isfile(os.path.join(package_dir, name))
    ]
    if missing:
        return {"path": src, "usable": False, "reason": "source_incomplete", "missing": missing}
    return {"path": src, "usable": True, "reason": "ok", "missing": []}


def add_optional_source_path(status):
    src = status.get("path") or ""
    if status.get("usable") and src and src not in sys.path:
        sys.path.insert(0, src)


def remove_source_path(status):
    src = status.get("path") or ""
    if src in sys.path:
        sys.path.remove(src)


def clear_jmcomic_modules():
    for name in list(sys.modules.keys()):
        if name == "jmcomic" or name.startswith("jmcomic."):
            del sys.modules[name]


def auto_install_enabled():
    value = os.environ.get("QQBOT_JM_AUTO_INSTALL", "1").strip().lower()
    return value not in ("0", "false", "no", "off")


def install_jm_dependencies():
    command = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
    ]
    if os.path.isfile(JM_REQUIREMENTS_FILE):
        command.extend(["--requirement", JM_REQUIREMENTS_FILE])
    else:
        command.extend(JM_DEPENDENCIES)
    subprocess.check_call(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def load_jmcomic():
    from jmcomic import JmOption, download_album
    return JmOption, download_album


def classify_import_failure(source_status, error_text):
    if source_status.get("reason") in ("source_missing", "source_incomplete"):
        return "missing_jmcomic_source"
    if "No module named 'jmcomic'" in error_text or 'No module named "jmcomic"' in error_text:
        return "missing_python_dependency"
    return "jmcomic_import_failed"


def import_jmcomic(allow_install=True):
    source_status = jm_source_status()
    add_optional_source_path(source_status)
    first_error = ""
    try:
        return load_jmcomic()
    except Exception as exc:
        first_error = type(exc).__name__ + ": " + str(exc)
        if source_status.get("usable"):
            remove_source_path(source_status)
            clear_jmcomic_modules()
            try:
                return load_jmcomic()
            except Exception as installed_exc:
                first_error = first_error + " | installed: " + type(installed_exc).__name__ + ": " + str(installed_exc)
        if allow_install and auto_install_enabled():
            try:
                install_jm_dependencies()
                clear_jmcomic_modules()
                return load_jmcomic()
            except Exception as retry_exc:
                first_error = first_error + " | retry: " + type(retry_exc).__name__ + ": " + str(retry_exc)
        emit({
            "ok": False,
            "reason": classify_import_failure(source_status, first_error),
            "error": "JM runtime dependencies are unavailable.",
            "error_category": "dependency",
            "files": 0,
            "bytes": 0,
            "all_success": False,
            "failed": 0,
            "failed_images": 0,
            "failed_photos": 0,
            "sourceReason": source_status.get("reason"),
            "missing": source_status.get("missing", []),
        })
        raise SystemExit(2)


def parse_jm_domains():
    raw = os.environ.get("QQBOT_JM_DOMAINS", "")
    return [
        item.strip()
        for item in raw.replace(";", ",").replace("\n", ",").split(",")
        if item.strip()
    ]


def build_option(JmOption, output_dir):
    return JmOption.construct({
        "log": False,
        "dir_rule": {
            "rule": "Bd_Pname",
            "base_dir": output_dir,
        },
        "download": {
            "cache": False,
            "image": {
                "decode": True,
                "suffix": None,
            },
            "threading": {
                "image": 12,
                "photo": 2,
            },
        },
        "client": {
            "cache": True,
            "impl": "api",
            "domain": parse_jm_domains(),
            "postman": {
                "type": "curl_cffi_session",
                "meta_data": {
                    "impersonate": "chrome",
                    "headers": None,
                    "proxies": None,
                    "timeout": REQUEST_TIMEOUT,
                },
            },
            "retry_times": 1,
        },
        "plugins": {
            "valid": "log",
        },
    })


class DownloadTimings:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.started = clock()
        self.lock = Lock()
        self.values = {"imageRequestsCompleted": 0, "imageRetriesCompleted": 0, "metadataCallsCompleted": 0, "imageSavesCompleted": 0}

    def mark(self, key, once=False):
        value = max(0, round((self.clock() - self.started) * 1000))
        with self.lock:
            if not once or key not in self.values:
                self.values[key] = value

    def duration(self, key, started):
        with self.lock:
            self.values[key] = max(0, round((self.clock() - started) * 1000))

    def request(self, kind, started, retry=False):
        value = max(0, round((self.clock() - started) * 1000))
        count = {"imageRequest": "imageRequestsCompleted", "metadata": "metadataCallsCompleted", "imageSave": "imageSavesCompleted"}[kind]
        with self.lock:
            self.values[count] += 1
            self.values[kind + "Ms"] = self.values.get(kind + "Ms", 0) + value
            self.values[kind + "MaxMs"] = max(self.values.get(kind + "MaxMs", 0), value)
            if retry:
                self.values["imageRetriesCompleted"] += 1

    def snapshot(self):
        with self.lock:
            return {**self.values, "observedMs": max(0, round((self.clock() - self.started) * 1000))}


def bound_image_requests(client, timings=None):
    original_request = client.request_with_retry
    metadata_state = local()

    def request_with_retry(self, request, url, domain_index=0, retry_count=0,
                           is_image=False, **kwargs):
        if not is_image:
            depth = getattr(metadata_state, "depth", 0)
            metadata_state.depth = depth + 1
            started = timings.clock() if timings is not None else None
            try:
                return original_request(request, url, domain_index, retry_count, is_image, **kwargs)
            finally:
                metadata_state.depth = depth
                if timings is not None and depth == 0:
                    timings.request("metadata", started)

        # Image URLs already select a CDN. API mirrors cannot repair that host.
        self.update_request_with_specify_domain(kwargs, None, True)
        kwargs["timeout"] = REQUEST_TIMEOUT
        for attempt in range(IMAGE_ATTEMPTS):
            started = timings.clock() if timings is not None else None
            try:
                return self.raise_if_resp_should_retry(request(url, **kwargs), True)
            except Exception:
                if attempt + 1 == IMAGE_ATTEMPTS:
                    raise
            finally:
                if timings is not None:
                    timings.request("imageRequest", started, retry=attempt > 0)

    client.request_with_retry = MethodType(request_with_retry, client)
    original_save = getattr(client, "save_image_resp", None)
    if timings is not None and callable(original_save):
        def save_image_resp(self, *args, **kwargs):
            started = timings.clock()
            try:
                return original_save(*args, **kwargs)
            finally:
                timings.request("imageSave", started)
        client.save_image_resp = MethodType(save_image_resp, client)
    return client


class DownloadProgress:
    def __init__(self, clock=time.monotonic, timings=None):
        self.clock = clock
        self.timings = timings
        self.lock = Lock()
        self.phase = "preparing"
        self.completed = 0
        self.total = None
        self.bytes = 0
        self.failed_images = 0
        self.failed_photos = 0
        self.photo_count = None
        self.photos = {}
        self.paths = set()
        self.downloader = None
        self.last_emit = None

    def _publish(self, force=False):
        now = self.clock()
        if not force and self.last_emit is not None and now - self.last_emit < 0.5:
            return
        payload = {
            "phase": self.phase,
            "completed": self.completed,
            "total": self.total,
            "bytes": self.bytes,
            "failed": self.failed_images + self.failed_photos,
        }
        if self.timings is not None:
            payload["timings"] = self.timings.snapshot()
        print(PROGRESS_PREFIX + json.dumps(payload), file=PROTOCOL_STDOUT, flush=True)
        self.last_emit = now

    def publish(self, phase=None, force=False):
        with self.lock:
            changed = phase is not None and self.phase != phase
            if phase is not None:
                self.phase = phase
            self._publish(force or changed)

    def before_album(self, album):
        with self.lock:
            if self.timings is not None:
                self.timings.mark("albumReadyMs")
            self.photo_count = len(album)
            self.phase = "downloading"
            self._publish(True)

    def before_photo(self, photo):
        with self.lock:
            self.photos[id(photo)] = len(photo)
            # Album page_count is not a substitute for fetched chapter manifests.
            if self.photo_count is not None and len(self.photos) == self.photo_count:
                self.total = sum(self.photos.values())
            self._publish()

    def after_image(self, path):
        size = os.path.getsize(path)
        if size <= 0:
            raise ValueError("Empty image output")
        with self.lock:
            path = os.path.abspath(path)
            if path not in self.paths:
                self.paths.add(path)
                self.completed += 1
                self.bytes += size
                if self.timings is not None:
                    self.timings.mark("firstImageMs", once=True)
                    self.timings.mark("lastImageMs")
            self._publish()

    def refresh_failures(self, downloader):
        with self.lock:
            self.failed_images = len(downloader.download_failed_image)
            self.failed_photos = len(downloader.download_failed_photo)
            self._publish()


def progress_downloader(JmDownloader, progress):
    class ProgressDownloader(JmDownloader):
        def __init__(self, option):
            super().__init__(option)
            progress.downloader = self

        def create_client(self):
            started = progress.timings.clock() if progress.timings is not None else None
            try:
                client = super().create_client()
            finally:
                if progress.timings is not None:
                    progress.timings.duration("clientInitMs", started)
            return bound_image_requests(client, progress.timings)

        def before_album(self, album):
            super().before_album(album)
            progress.before_album(album)

        def before_photo(self, photo):
            super().before_photo(photo)
            progress.before_photo(photo)

        def after_image(self, image, img_save_path):
            super().after_image(image, img_save_path)
            progress.after_image(img_save_path)

        def download_by_image_detail(self, image):
            try:
                return super().download_by_image_detail(image)
            finally:
                progress.refresh_failures(self)

        def download_by_photo_detail(self, photo):
            try:
                return super().download_by_photo_detail(photo)
            finally:
                progress.refresh_failures(self)

    return ProgressDownloader


def error_category(exc):
    names = {cls.__name__.lower() for cls in type(exc).__mro__}
    if any("timeout" in name for name in names):
        return "timeout"
    if any("connection" in name or "request" in name or "curl" in name for name in names):
        return "network"
    if any("image" in name or "unidentified" in name for name in names):
        return "image"
    if isinstance(exc, OSError):
        return "filesystem"
    return "download"


def failure_result(progress, category, files=0, bytes_total=0):
    return {
        "ok": False,
        "reason": "download_failed",
        "error": "JM download failed or is incomplete.",
        "error_category": category,
        "files": files,
        "bytes": bytes_total,
        "all_success": False,
        "failed": progress.failed_images + progress.failed_photos,
        "failed_images": progress.failed_images,
        "failed_photos": progress.failed_photos,
        "timings": progress.timings.snapshot() if progress.timings is not None else {},
    }


def summarize(root):
    files = 0
    bytes_total = 0
    for base, _dirs, names in os.walk(root):
        for name in names:
            path = os.path.join(base, name)
            if os.path.isfile(path):
                files += 1
                bytes_total += os.path.getsize(path)
    return files, bytes_total


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--id")
    parser.add_argument("--out")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    if args.check:
        with quiet_dependencies():
            import_jmcomic()
        emit({
            "ok": True,
            "reason": "runtime_ok",
            "source": jm_source_status().get("reason"),
            "domains": len(parse_jm_domains()),
        })
        return

    if not args.id or not args.out:
        parser.error("--id and --out are required unless --check is used")

    timings = DownloadTimings()
    progress = DownloadProgress(timings=timings)
    progress.publish(force=True)
    try:
        with quiet_dependencies():
            os.makedirs(args.out, exist_ok=True)
            JmOption, download_album = import_jmcomic(allow_install=False)
            from jmcomic import JmDownloader
            timings.mark("importMs")
            option = build_option(JmOption, args.out)
            album, downloader = download_album(
                args.id, option=option, check_exception=True,
                downloader=progress_downloader(JmDownloader, progress),
            )
            progress.refresh_failures(downloader)
            timings.mark("downloadFinishedMs")
            files, bytes_total = summarize(args.out)
            complete = (
                bool(downloader.all_success)
                and progress.failed_images == 0 and progress.failed_photos == 0
                and progress.total is not None and progress.total > 0
                and all(count > 0 for count in progress.photos.values())
                and progress.completed == progress.total == files
                and bytes_total == progress.bytes and bytes_total > 0
            )
        progress.publish(force=True)
        if not complete:
            emit(failure_result(progress, "incomplete", files, bytes_total))
            raise SystemExit(1)
        progress.publish(phase="preparing", force=True)
        emit({
            "ok": True,
            "id": str(args.id),
            "title": getattr(album, "name", ""),
            "files": files,
            "bytes": bytes_total,
            "all_success": True,
            "timings": timings.snapshot(),
        })
    except Exception as exc:
        if progress.downloader is not None:
            progress.refresh_failures(progress.downloader)
        progress.publish(force=True)
        emit(failure_result(progress, error_category(exc), progress.completed, progress.bytes))
        raise SystemExit(1)
    finally:
        with quiet_dependencies():
            session = getattr(getattr(getattr(progress.downloader, "client", None), "postman", None), "session", None)
            if session is not None:
                try:
                    session.close()
                except Exception:
                    pass


if __name__ == "__main__":
    main()
