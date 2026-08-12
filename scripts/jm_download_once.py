import argparse
import json
import os
import subprocess
import sys
import traceback

RESULT_PREFIX = "QQFRIEND_JM_RESULT "
JM_DEPENDENCIES = [
    "jmcomic",
    "curl_cffi",
    "commonX",
    "PyYAML",
    "Pillow",
    "pycryptodome",
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
    print(RESULT_PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)


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
    subprocess.check_call(command)


def load_jmcomic():
    from jmcomic import JmOption, download_album
    return JmOption, download_album


def classify_import_failure(source_status, error_text):
    if source_status.get("reason") in ("source_missing", "source_incomplete"):
        return "missing_jmcomic_source"
    if "No module named 'jmcomic'" in error_text or 'No module named "jmcomic"' in error_text:
        return "missing_python_dependency"
    return "jmcomic_import_failed"


def import_jmcomic():
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
        if auto_install_enabled():
            print("QQFRIEND_JM_DEPENDENCY_INSTALL start", file=sys.stderr, flush=True)
            try:
                install_jm_dependencies()
                clear_jmcomic_modules()
                return load_jmcomic()
            except Exception as retry_exc:
                first_error = first_error + " | retry: " + type(retry_exc).__name__ + ": " + str(retry_exc)
        emit({
            "ok": False,
            "reason": classify_import_failure(source_status, first_error),
            "error": first_error,
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
            "cache": None,
            "impl": "api",
            "domain": parse_jm_domains(),
            "postman": {
                "type": "curl_cffi",
                "meta_data": {
                    "impersonate": "chrome",
                    "headers": None,
                    "proxies": None,
                },
            },
            "retry_times": 5,
        },
        "plugins": {
            "valid": "log",
        },
    })


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

    os.makedirs(args.out, exist_ok=True)
    JmOption, download_album = import_jmcomic()

    try:
        option = build_option(JmOption, args.out)
        album, downloader = download_album(args.id, option=option, check_exception=True)
        files, bytes_total = summarize(args.out)
        emit({
            "ok": True,
            "id": str(args.id),
            "title": getattr(album, "name", ""),
            "files": files,
            "bytes": bytes_total,
            "all_success": bool(getattr(downloader, "all_success", False)),
        })
    except Exception as exc:
        traceback.print_exc()
        emit({"ok": False, "reason": "download_failed", "error": str(exc)})
        raise SystemExit(1)


if __name__ == "__main__":
    main()
