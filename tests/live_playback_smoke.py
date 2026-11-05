"""Report simulated playback to a REAL isolated Jellyfin server and verify its plugin event.

This checks the server's playback-reporting pipeline, not actual video decoding or
Kinopoisk rating submission. The generated test file must already exist in /media.
Run tests/live_server_smoke.py first. All mutations target 127.0.0.1:18096 only.
"""
import sys
import time
from urllib.parse import urlencode
from uuid import uuid4

from live_server_smoke import Client, SmokeFailure, STATE, private_json, read_json


BASE = "http://127.0.0.1:18096"
LIBRARY_NAME = "Kinopoisk Smoke Movies"
TEST_PATH = "/media/Plugin Test (2026).mp4"


def run():
    auth_path = STATE / "auth.json"
    if not auth_path.exists():
        raise SmokeFailure("Run live_server_smoke.py first")
    auth = read_json(auth_path)
    if auth.get("baseUrl", "").rstrip("/") != BASE:
        raise SmokeFailure("Refusing authentication for a non-test endpoint")
    client = Client(BASE)
    client.token = auth["accessToken"]
    info = client.json("/System/Info/Public")
    if info.get("Version") != "10.11.5" or info.get("ServerName") != "Kinopoisk isolated smoke test":
        raise SmokeFailure("Refusing non-smoke server")

    libraries = client.json("/Library/VirtualFolders", authenticated=True)
    existing = next((x for x in libraries if x.get("Name") == LIBRARY_NAME), None)
    if existing is None:
        parameters = urlencode({"name": LIBRARY_NAME, "collectionType": "movies", "paths": "/media", "refreshLibrary": "true"})
        client.expect("/Library/VirtualFolders?" + parameters, method="POST", authenticated=True, status=204, payload={
            "LibraryOptions": {
                "EnableRealtimeMonitor": False,
                "EnableChapterImageExtraction": False,
                "EnableAutomaticSeriesGrouping": False,
                "SaveLocalMetadata": False,
                "TypeOptions": [{"Type": "Movie", "MetadataFetchers": [], "ImageFetchers": []}],
            },
        })
        print("PASS: isolated local media library created")
    elif "/media" not in existing.get("Locations", []):
        raise SmokeFailure("Test library points outside /media")

    query = urlencode({"UserId": auth["userId"], "Recursive": "true", "IncludeItemTypes": "Movie", "Fields": "Path,ProviderIds,MediaSources"})
    item = None
    for _ in range(30):
        items = client.json("/Items?" + query, authenticated=True).get("Items", [])
        item = next((x for x in items if x.get("Path") == TEST_PATH), None)
        if item and item.get("RunTimeTicks", 0) > 0:
            break
        time.sleep(1)
    if not item or not item.get("RunTimeTicks", 0):
        raise SmokeFailure("Generated test movie was not indexed with a runtime within 30 seconds")

    item_id = item["Id"]
    detail = client.json(f"/Users/{auth['userId']}/Items/{item_id}", authenticated=True)
    # Preserve the existing DTO while assigning a deterministic provider ID for
    # this generated test fixture; this does not fetch or rate a Kinopoisk title.
    detail.setdefault("ProviderIds", {})["kinopoisk"] = "301"
    detail["LockData"] = True
    for key in ("Tags", "Genres", "Studios", "People", "Taglines", "ProductionLocations"):
        if detail.get(key) is None:
            detail[key] = []
    client.expect(f"/Items/{item_id}", method="POST", payload=detail, authenticated=True, status=204)
    verified = client.json(f"/Users/{auth['userId']}/Items/{item_id}", authenticated=True)
    if verified.get("ProviderIds", {}).get("kinopoisk") != "301":
        raise SmokeFailure("Test metadata did not retain kinopoisk ID 301")
    print("PASS: generated movie indexed with test provider ID")
    private_json(STATE / "item.json", {"itemId": item_id, "runtimeTicks": verified["RunTimeTicks"], "kinopoiskId": "301"})

    play_session = uuid4().hex
    sources = verified.get("MediaSources") or item.get("MediaSources") or []
    source_id = sources[0]["Id"] if sources else item_id
    common = {"ItemId": item_id, "MediaSourceId": source_id, "PlaySessionId": play_session}
    client.expect("/Sessions/Playing", method="POST", authenticated=True, status=204, payload={
        **common, "PositionTicks": 0, "CanSeek": True, "IsPaused": False,
        "IsMuted": False, "VolumeLevel": 100, "PlayMethod": "DirectPlay", "RepeatMode": "RepeatNone",
    })
    client.expect("/Sessions/Playing/Stopped", method="POST", authenticated=True, status=204, payload={
        **common, "PositionTicks": verified["RunTimeTicks"], "Failed": False,
    })
    print("PASS: simulated start/completion reports accepted by real Jellyfin")

    for _ in range(20):
        queue = client.json("/KinopoiskRatings/queue", authenticated=True)
        match = [x for x in queue if x.get("kinopoiskId") == "301"]
        if match:
            if len(match) != 1 or match[0].get("title") != verified.get("Name") or match[0].get("kind") != "movie":
                raise SmokeFailure("Playback queue entry has wrong title/type or duplicates")
            private_json(STATE / "item.json", {
                "itemId": item_id, "runtimeTicks": verified["RunTimeTicks"],
                "kinopoiskId": "301", "queueId": match[0]["id"],
            })
            print("PASS: real playback event queued one rating for the authenticated user")
            print("NOTE: API playback simulation only; no video decoding or Kinopoisk submission performed")
            return
        time.sleep(0.5)
    raise SmokeFailure("Playback completed but no pending rating appeared")


if __name__ == "__main__":
    try:
        run()
    except SmokeFailure as error:
        print("FAIL: " + str(error))
        sys.exit(1)
