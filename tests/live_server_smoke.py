"""Exercise a real, isolated Jellyfin server (never a production endpoint).

Run: python tests/live_server_smoke.py
Credentials/token stay under the ignored .research/jellyfin-smoke directory.
This script does not contact Kinopoisk or create external ratings.
"""
from argparse import ArgumentParser
import json
from pathlib import Path
import secrets
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".research" / "jellyfin-smoke"
AUTH = 'MediaBrowser Client="Kinopoisk Smoke", Device="Local Test", DeviceId="kinopoisk-smoke", Version="0.2.0"'


class SmokeFailure(Exception):
    pass


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def private_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


class Client:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.token = None

    def request(self, path, method="GET", payload=None, authenticated=False):
        headers = {"X-Emby-Authorization": AUTH}
        if authenticated:
            if not self.token:
                raise SmokeFailure("Missing local test authentication")
            headers["X-Emby-Token"] = self.token
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload).encode("utf-8")
        request = Request(self.base + path, body, headers, method=method)
        try:
            with urlopen(request, timeout=20) as response:
                return response.status, response.read().decode("utf-8")
        except HTTPError as error:
            # Error bodies can contain headers; never print them.
            return error.code, error.read().decode("utf-8", errors="replace")
        except (URLError, TimeoutError) as error:
            raise SmokeFailure(f"Server unavailable at {self.base} ({type(error).__name__})") from None

    def expect(self, path, status=200, **kwargs):
        actual, body = self.request(path, **kwargs)
        if actual != status:
            raise SmokeFailure(f"{kwargs.get('method', 'GET')} {path}: expected HTTP {status}, got {actual}")
        return body

    def json(self, path, **kwargs):
        try:
            return json.loads(self.expect(path, **kwargs))
        except json.JSONDecodeError:
            raise SmokeFailure(f"{path}: expected JSON response") from None


def run(base):
    url = urlsplit(base)
    if url.scheme != "http" or url.hostname != "127.0.0.1" or url.port != 18096 or url.path not in ("", "/") or url.query or url.fragment:
        raise SmokeFailure("Refusing non-test endpoint: use http://127.0.0.1:18096 only")
    client = Client(base)
    info = client.json("/System/Info/Public")
    if info.get("Version") != "10.11.5":
        raise SmokeFailure("Expected Jellyfin 10.11.5")

    credential_path = STATE / "credentials.json"
    setup_completed = info.get("StartupWizardCompleted", info.get("IsStartupWizardCompleted"))
    if not setup_completed:
        if credential_path.exists():
            credentials = read_json(credential_path)
        else:
            credentials = {"username": "kp-smoke-admin", "password": secrets.token_urlsafe(32)}
            private_json(credential_path, credentials)
        client.expect("/Startup/Configuration", method="POST", status=204, payload={
            "ServerName": "Kinopoisk isolated smoke test", "UICulture": "en-US",
            "MetadataCountryCode": "US", "PreferredMetadataLanguage": "en",
        })
        client.expect("/Startup/User")
        client.expect("/Startup/User", method="POST", status=204, payload={
            "Name": credentials["username"], "Password": credentials["password"],
        })
        # Docker NAT may identify browser/API clients as remote. Port is bound only
        # to host loopback by the launcher; do not enable UPnP or publish discovery.
        client.expect("/Startup/RemoteAccess", method="POST", status=204, payload={"EnableRemoteAccess": True})
        client.expect("/Startup/Complete", method="POST", status=204)
        print("PASS: isolated startup wizard completed")
    elif not credential_path.exists():
        raise SmokeFailure("Server is configured but this test has no credentials; refusing to modify existing users")

    credentials = read_json(credential_path)
    auth = client.json("/Users/AuthenticateByName", method="POST", payload={
        "Username": credentials["username"], "Pw": credentials["password"],
    })
    client.token = auth["AccessToken"]
    private_json(STATE / "auth.json", {
        "baseUrl": base, "accessToken": client.token, "userId": auth["User"]["Id"],
        "serverId": auth.get("ServerId", info.get("Id")), "deviceId": "kinopoisk-smoke",
    })
    print("PASS: local test user authenticated (credentials redacted)")

    failures = []

    def check(label, operation):
        try:
            operation()
            print("PASS: " + label)
        except (SmokeFailure, AssertionError) as error:
            message = str(error) or label
            failures.append(message)
            print("FAIL: " + message)

    def plugins():
        installed = client.json("/Plugins", authenticated=True)
        for name in ("File Transformation", "Kinopoisk Ratings"):
            plugin = next((item for item in installed if item.get("Name") == name), None)
            assert plugin is not None, name + " not present in installed plugins"
            assert plugin.get("Status") in (None, "Active"), name + " not active: " + str(plugin.get("Status"))

    def web_html():
        html = client.expect("/web/index.html")
        assert "KinopoiskRatings/client.js" in html, "Server HTML does not load the Kinopoisk Ratings script"

    def script():
        js = client.expect("/KinopoiskRatings/client.js")
        assert "__kinopoiskRatingsLoaded" in js, "Public plugin endpoint did not serve the expected JavaScript"

    def queue():
        data = client.json("/KinopoiskRatings/queue", authenticated=True)
        assert isinstance(data, list), "Queue response must be a list"

    def connection():
        data = client.json("/KinopoiskRatings/connection", authenticated=True)
        assert isinstance(data.get("connected"), bool), "Connection response must contain boolean connected"

    def playback():
        data = client.json("/KinopoiskRatings/playback-active", authenticated=True)
        assert isinstance(data.get("active"), bool), "Playback response must contain boolean active"

    check("both plugins active", plugins)
    check("server HTML loads rating UI", web_html)
    check("public JavaScript resource", script)
    check("authenticated queue", queue)
    check("authenticated connection", connection)
    check("authenticated playback state", playback)
    check("queue rejects unauthenticated requests", lambda: client.expect("/KinopoiskRatings/queue", status=401))
    if failures:
        raise SmokeFailure(f"{len(failures)} live integration check(s) failed")
    print("PASS: all live Jellyfin API/UI-loading checks")


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:18096")
    args = parser.parse_args()
    try:
        run(args.base_url)
    except SmokeFailure as error:
        print("FAIL: " + str(error))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
