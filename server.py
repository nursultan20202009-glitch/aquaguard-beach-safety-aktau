"""Local Smart City Aktau MVP: real person detection, test-zone alerting, SQLite API."""

import json
import math
import os
import re
import sqlite3
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

for dependency_dir in (".runtime", ".deps"):
    local_deps = Path(__file__).resolve().parent / dependency_dir
    if local_deps.is_dir():
        sys.path.insert(0, str(local_deps))
        break

import cv2
import numpy as np
import onnxruntime as ort


ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("DATA_DIR", str(ROOT / "data")))
SNAPSHOTS = DATA / "evidence"
DB = DATA / "alerts.sqlite3"
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
MODEL = ROOT / "assets" / "yolov8n.onnx"
DEFAULT_VIDEO = ROOT / "assets" / "swimmer-water.mp4"
RAW_SOURCE = os.environ.get("VIDEO_SOURCE", str(DEFAULT_VIDEO))
SOURCE = int(RAW_SOURCE) if RAW_SOURCE.isdigit() else RAW_SOURCE
IS_TEST_SOURCE = os.environ.get("VIDEO_SOURCE") is None
SOURCE_LABEL = os.environ.get("SOURCE_LABEL", "Тестовая съёмка пловца в воде" if IS_TEST_SOURCE else "Внешний видеоисточник")
SOURCES = {
    "coast": {"path": str(ROOT / "assets" / "beach-aerial.mp4"), "label": "Обзор пляжа · тестовое видео с дрона", "zone": [0.18, 0.14, 0.82, 0.86]},
    "detection": {"path": str(DEFAULT_VIDEO), "label": "Проверка тревоги · пловец в воде", "zone": CONFIG["video_zone"]},
}
ZONE_LAT = float(os.environ.get("ZONE_LAT", CONFIG["latitude"]))
ZONE_LON = float(os.environ.get("ZONE_LON", CONFIG["longitude"]))
COORDINATE_KIND = "configured_zone" if os.environ.get("ZONE_LAT") and os.environ.get("ZONE_LON") else "test_zone"
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))

DATA.mkdir(exist_ok=True)
SNAPSHOTS.mkdir(exist_ok=True)


def connect():
    connection = sqlite3.connect(DB, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


with connect() as conn:
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        beach TEXT NOT NULL,
        zone TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        coordinate_kind TEXT NOT NULL,
        event_type TEXT NOT NULL,
        track_id INTEGER NOT NULL,
        confidence REAL NOT NULL,
        source_label TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('new','accepted','closed')),
        updated_at TEXT NOT NULL
    )""")
    existing_columns = {row[1] for row in conn.execute("PRAGMA table_info(events)")}
    for column in ("accepted_at", "closed_at", "operator_note"):
        if column not in existing_columns:
            conn.execute(f"ALTER TABLE events ADD COLUMN {column} TEXT")
    conn.execute("UPDATE events SET accepted_at=updated_at WHERE status='accepted' AND accepted_at IS NULL")
    conn.execute("UPDATE events SET closed_at=updated_at WHERE status='closed' AND closed_at IS NULL")


def event_rows():
    with connect() as conn:
        return [dict(row) for row in conn.execute("SELECT * FROM events ORDER BY created_at DESC LIMIT 100")]


def event_row(event_id):
    with connect() as conn:
        row = conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    return dict(row) if row else None


def test_point_for_zone():
    """Use the configured test location for the single video zone, never real GPS."""
    points = CONFIG.get("map_points", [])
    if COORDINATE_KIND != "test_zone" or not points:
        return None
    return points[0]


def insert_event(track_id, confidence, frame, test_point=None, source_label=None):
    event_id = str(uuid.uuid4())
    snapshot_name = f"{event_id}.jpg"
    cv2.imwrite(str(SNAPSHOTS / snapshot_name), frame, [cv2.IMWRITE_JPEG_QUALITY, 86])
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    event_zone = f"{test_point['name']} · тестовая точка в море" if test_point else CONFIG["zone"]
    event_lat = test_point["latitude"] if test_point else ZONE_LAT
    event_lon = test_point["longitude"] if test_point else ZONE_LON
    with connect() as conn:
        conn.execute("""INSERT INTO events
            (id, created_at, beach, zone, latitude, longitude, coordinate_kind,
             event_type, track_id, confidence, source_label, snapshot, status, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
            event_id, now, CONFIG["beach"], event_zone, event_lat, event_lon,
            COORDINATE_KIND, "Человек в опасной зоне — проверьте", track_id,
            round(float(confidence), 3), source_label or SOURCE_LABEL, snapshot_name, "new", now,
        ))
    return event_id


def letterbox(frame):
    height, width = frame.shape[:2]
    scale = min(640 / width, 640 / height)
    new_width, new_height = round(width * scale), round(height * scale)
    pad_x, pad_y = (640 - new_width) // 2, (640 - new_height) // 2
    image = np.full((640, 640, 3), 114, dtype=np.uint8)
    image[pad_y:pad_y + new_height, pad_x:pad_x + new_width] = cv2.resize(frame, (new_width, new_height))
    tensor = cv2.cvtColor(image, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)[None]
    return np.ascontiguousarray(tensor, dtype=np.float32) / 255.0, scale, pad_x, pad_y


def detect_people(session, frame):
    tensor, scale, pad_x, pad_y = letterbox(frame)
    output = session.run(None, {session.get_inputs()[0].name: tensor})[0][0]
    # COCO class 0 is person. The model emits [x,y,w,h,80 class scores] for 8400 candidates.
    candidates = np.where(output[4] >= 0.32)[0]
    height, width = frame.shape[:2]
    boxes, scores = [], []
    for index in candidates:
        x, y, w, h = output[:4, index]
        x1 = max(0, int((x - w / 2 - pad_x) / scale))
        y1 = max(0, int((y - h / 2 - pad_y) / scale))
        x2 = min(width - 1, int((x + w / 2 - pad_x) / scale))
        y2 = min(height - 1, int((y + h / 2 - pad_y) / scale))
        if x2 > x1 and y2 > y1:
            boxes.append([x1, y1, x2 - x1, y2 - y1])
            scores.append(float(output[4, index]))
    keep = cv2.dnn.NMSBoxes(boxes, scores, 0.32, 0.45)
    return [(boxes[int(i)], scores[int(i)]) for i in np.array(keep).reshape(-1)] if len(keep) else []


class VideoWorker(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.lock = threading.Lock()
        self.frame = None
        self.people = 0
        self.frame_number = 0
        self.error = None
        self.ready = False
        self.finished = False
        self.tracks = {}
        self.next_track_id = 1
        self.last_alert_at = 0.0
        self.restart_requested = False
        self.last_event_id = None
        self.mode = "detection" if IS_TEST_SOURCE else "external"
        self.requested_mode = None

    def select_source(self, mode):
        with self.lock:
            self.requested_mode = mode
            self.restart_requested = True

    def restart(self):
        with self.lock:
            self.restart_requested = True

    def public_state(self):
        with self.lock:
            return {
                "ready": self.ready, "error": self.error,
                "finished": self.finished,
                "people": self.people, "frame_number": self.frame_number,
                "last_event_id": self.last_event_id,
                "mode": self.mode,
            }

    def match_tracks(self, detections, frame_width, frame_height, zone_rect):
        now = time.monotonic()
        matched = set()
        result = []
        for box, confidence in sorted(detections, key=lambda item: -item[1]):
            x, y, width, height = box
            foot = (x + width / 2, y + height)
            best_id, best_distance = None, 90.0
            for track_id, track in self.tracks.items():
                if track_id in matched or now - track["seen"] > 1.8:
                    continue
                distance = math.dist(foot, track["foot"])
                if distance < best_distance:
                    best_id, best_distance = track_id, distance
            if best_id is None:
                best_id = self.next_track_id
                self.next_track_id += 1
                self.tracks[best_id] = {"foot": foot, "seen": now, "inside_since": None, "alerted": False}
            track = self.tracks[best_id]
            track["foot"], track["seen"] = foot, now
            matched.add(best_id)
            x1, y1, x2, y2 = zone_rect
            inside = x1 <= foot[0] / frame_width <= x2 and y1 <= foot[1] / frame_height <= y2
            test_point = test_point_for_zone() if inside else None
            if inside and track["inside_since"] is None:
                track["inside_since"] = now
            if not inside:
                track["inside_since"] = None
            due = inside and not track["alerted"] and now - track["inside_since"] >= CONFIG["dwell_seconds"]
            result.append((best_id, box, confidence, inside, due, test_point))
        self.tracks = {key: value for key, value in self.tracks.items() if now - value["seen"] < 2.0}
        return result

    def run(self):
        try:
            session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
            capture = cv2.VideoCapture(SOURCE)
            if not capture.isOpened():
                raise RuntimeError(f"Не удалось открыть видеоисточник: {SOURCE}")
            fps = capture.get(cv2.CAP_PROP_FPS) or 10
            frame_step = max(1, round(fps / 6)) if IS_TEST_SOURCE else 1
            while True:
                start = time.monotonic()
                with self.lock:
                    restart = self.restart_requested
                    self.restart_requested = False
                    requested_mode = self.requested_mode
                    self.requested_mode = None
                if restart:
                    if requested_mode and IS_TEST_SOURCE:
                        capture.release()
                        capture = cv2.VideoCapture(SOURCES[requested_mode]["path"])
                        if not capture.isOpened():
                            raise RuntimeError(f"Не удалось открыть видеоисточник: {requested_mode}")
                        fps = capture.get(cv2.CAP_PROP_FPS) or 10
                        frame_step = max(1, round(fps / (6 if requested_mode == "detection" else 3)))
                        with self.lock:
                            self.mode = requested_mode
                            self.ready = False
                            self.frame = None
                    capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    self.tracks.clear()
                    self.next_track_id = 1
                    self.last_alert_at = 0.0
                    with self.lock:
                        self.finished = False
                ok, frame = capture.read()
                if not ok:
                    if IS_TEST_SOURCE:
                        if self.mode == "coast":
                            capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
                            continue
                        with self.lock:
                            self.finished = True
                        time.sleep(0.25)
                        continue
                    raise RuntimeError("Видеоисточник завершился или пропал")
                for _ in range(frame_step - 1):
                    capture.grab()
                detections = detect_people(session, frame)
                height, width = frame.shape[:2]
                zone_rect = SOURCES[self.mode]["zone"] if IS_TEST_SOURCE else CONFIG["video_zone"]
                tracks = self.match_tracks(detections, width, height, zone_rect)
                overlay = frame.copy()
                x1, y1, x2, y2 = zone_rect
                left, top, right, bottom = int(x1 * width), int(y1 * height), int(x2 * width), int(y2 * height)
                cv2.rectangle(overlay, (left, top), (right, bottom), (18, 48, 245), -1)
                frame = cv2.addWeighted(overlay, 0.16, frame, 0.84, 0)
                cv2.rectangle(frame, (left, top), (right, bottom), (31, 63, 252), 2)
                cv2.putText(frame, "TEST ZONE A", (left + 8, max(20, top - 9)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (38, 70, 255), 2)
                for track_id, (x, y, bw, bh), confidence, inside, due, test_point in tracks:
                    color = (29, 75, 250) if inside else (94, 231, 128)
                    cv2.rectangle(frame, (x, y), (x + bw, y + bh), color, 2)
                    cv2.circle(frame, (x + bw // 2, y + bh), 4, color, -1)
                    cv2.putText(frame, f"ID {track_id}  {confidence:.2f}", (x, max(18, y - 7)), cv2.FONT_HERSHEY_SIMPLEX, 0.47, color, 2)
                for track_id, box, confidence, inside, due, test_point in tracks:
                    if due:
                        self.tracks[track_id]["alerted"] = True
                        if time.monotonic() - self.last_alert_at >= CONFIG["alert_cooldown_seconds"]:
                            label = SOURCES[self.mode]["label"] if IS_TEST_SOURCE else SOURCE_LABEL
                            event_id = insert_event(track_id, confidence, frame, test_point, label)
                            self.last_alert_at = time.monotonic()
                            with self.lock:
                                self.last_event_id = event_id
                success, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 78])
                if success:
                    with self.lock:
                        self.frame = encoded.tobytes()
                        self.people = len(tracks)
                        self.frame_number = int(capture.get(cv2.CAP_PROP_POS_FRAMES))
                        self.ready = True
                time.sleep(max(0, frame_step / fps - (time.monotonic() - start)))
        except Exception as exc:
            with self.lock:
                self.error = str(exc)
            print(f"Video worker error: {exc}", flush=True)


worker = VideoWorker()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        if not (self.path.startswith('/api/frame.jpg') or self.path.startswith('/api/state')):
            super().log_message(format, *args)

    def send_bytes(self, payload, content_type, status=200, cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, data, status=200):
        self.send_bytes(json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            video_state = worker.public_state()
            mode = video_state["mode"]
            self.send_json({
                "video": video_state, "events": event_rows(),
                "source_label": SOURCES[mode]["label"] if IS_TEST_SOURCE else SOURCE_LABEL,
                "is_test_source": IS_TEST_SOURCE,
                "zone": {"beach": CONFIG["beach"], "name": CONFIG["zone"], "latitude": ZONE_LAT,
                         "longitude": ZONE_LON, "coordinate_kind": COORDINATE_KIND,
                         "dwell_seconds": CONFIG["dwell_seconds"]},
                "map_points": CONFIG.get("map_points", []) if COORDINATE_KIND == "test_zone" else [],
            })
            return
        detail = re.fullmatch(r"/api/events/([0-9a-f-]{36})", path)
        if detail:
            row = event_row(detail.group(1))
            self.send_json(row if row else {"error": "Событие не найдено"}, 200 if row else 404)
            return
        if path == "/api/frame.jpg":
            with worker.lock:
                frame = worker.frame
            if frame is None:
                self.send_json({"error": "Кадр пока недоступен"}, 503)
            else:
                self.send_bytes(frame, "image/jpeg")
            return
        snapshot = re.fullmatch(r"/api/snapshots/([0-9a-f-]{36})\.jpg", path)
        if snapshot:
            file = SNAPSHOTS / f"{snapshot.group(1)}.jpg"
            if file.is_file():
                self.send_bytes(file.read_bytes(), "image/jpeg", cache="private, max-age=3600")
                return
        files = {"/": ("index.html", "text/html; charset=utf-8"),
                 "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                 "/styles.css": ("styles.css", "text/css; charset=utf-8"),
                 "/map.css": ("map.css", "text/css; charset=utf-8"),
                 "/case.css": ("case.css", "text/css; charset=utf-8"),
                 "/navigation.css": ("navigation.css", "text/css; charset=utf-8"),
                 "/report.html": ("report.html", "text/html; charset=utf-8"),
                 "/report.js": ("report.js", "text/javascript; charset=utf-8"),
                 "/report.css": ("report.css", "text/css; charset=utf-8"),
                 "/vendor/leaflet.css": ("vendor/leaflet.css", "text/css; charset=utf-8"),
                 "/vendor/leaflet.js": ("vendor/leaflet.js", "text/javascript; charset=utf-8")}
        if path in files:
            filename, content_type = files[path]
            self.send_bytes((ROOT / "public" / filename).read_bytes(), content_type, cache="no-cache")
        else:
            self.send_json({"error": "Не найдено"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/demo/restart":
            worker.restart()
            self.send_json({"ok": True})
        elif path == "/api/demo/source" and IS_TEST_SOURCE:
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size > 256:
                    raise ValueError
                mode = json.loads(self.rfile.read(size)).get("source")
            except (ValueError, TypeError, AttributeError):
                mode = None
            if mode not in SOURCES:
                self.send_json({"error": "Неизвестный видеоисточник"}, 400)
            else:
                worker.select_source(mode)
                self.send_json({"ok": True, "source": mode})
        else:
            self.send_json({"error": "Не найдено"}, 404)

    def do_PATCH(self):
        matched = re.fullmatch(r"/api/events/([0-9a-f-]{36})", urlparse(self.path).path)
        if not matched:
            self.send_json({"error": "Не найдено"}, 404)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size > 2048:
                raise ValueError("Слишком большой запрос")
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError("Некорректный запрос")
        except (ValueError, KeyError, TypeError):
            self.send_json({"error": "Некорректный запрос"}, 400)
            return
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if "note" in payload and "status" not in payload:
            note = payload["note"]
            if not isinstance(note, str) or len(note) > 500:
                self.send_json({"error": "Заметка должна содержать не более 500 символов"}, 400)
                return
            with connect() as conn:
                result = conn.execute("UPDATE events SET operator_note=?, updated_at=? WHERE id=?",
                                      (note.strip(), now, matched.group(1)))
            if result.rowcount != 1:
                self.send_json({"error": "Событие не найдено"}, 404)
            else:
                self.send_json({"ok": True, "operator_note": note.strip(), "updated_at": now})
            return
        status = payload.get("status")
        if status not in ("accepted", "closed"):
            self.send_json({"error": "Недопустимый статус"}, 400)
            return
        expected = "new" if status == "accepted" else "accepted"
        timestamp_column = "accepted_at" if status == "accepted" else "closed_at"
        with connect() as conn:
            result = conn.execute(f"UPDATE events SET status=?, updated_at=?, {timestamp_column}=? WHERE id=? AND status=?",
                                  (status, now, now, matched.group(1), expected))
        if result.rowcount != 1:
            self.send_json({"error": "Событие не найдено или статус уже изменён"}, 409)
        else:
            self.send_json({"ok": True, "status": status, "updated_at": now})


if __name__ == "__main__":
    worker.start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"AquaGuard Aktau MVP: http://{HOST}:{PORT}", flush=True)
    server.serve_forever()
