#!/usr/bin/env python3
"""
Somatica Library Worker - serveur Flask local.

Expose des endpoints HTTP consommés par la UI Library :
  - GET  /health                    -> ping public
  - GET  /icloud/albums             -> liste les albums iCloud avec nb de vidéos
  - POST /icloud/sync               -> lance la synchro (album = settings ou body)
  - GET  /thumbnails/check          -> compte les miniatures manquantes
  - POST /thumbnails/backfill       -> génère les miniatures manquantes
  - POST /faces/build               -> Phase 1 : construit face_clusters depuis videos nommées
  - POST /faces/match               -> Phase 2 : identifie les _UNKNOWN_, crée des clusters
  - GET  /faces/clusters            -> liste les clusters avec thumbnails pour la UI
  - POST /faces/rename              -> renomme un cluster (DB + video_library.persons_detected)
  - GET  /settings/<key>            -> lit une entrée library_settings
  - PUT  /settings/<key>            -> écrit une entrée library_settings
  - GET  /jobs/<id>                 -> statut d'un job en cours
  - GET  /status/last-runs          -> les 20 derniers runs (import_log)

Auth : header Authorization: Bearer $WORKER_TOKEN (sauf /health).

Lancer :
  cd export-icloud && source .venv/bin/activate
  python3 library_worker.py
"""

import os
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from face_db_supabase import FaceDBSupabase


# ---------------------------------------------------------------------------
# Env
# ---------------------------------------------------------------------------

def load_env():
    env_path = HERE / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
STORE_BACKGROUND_TOKEN = os.environ.get("STORE_BACKGROUND_TOKEN", "")
WORKER_TOKEN = os.environ.get("WORKER_TOKEN", "")
WORKER_PORT = int(os.environ.get("WORKER_PORT", "8787"))

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    sys.exit("SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis dans .env")

if not WORKER_TOKEN:
    sys.exit(
        "WORKER_TOKEN absent. Ajoute une ligne dans .env :\n"
        '  WORKER_TOKEN="un-token-aleatoire-long"\n'
        "Genere-le avec :  python3 -c 'import secrets; print(secrets.token_urlsafe(32))'"
    )


SB_HEADERS = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    "Content-Type": "application/json",
}


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = Flask(__name__)
# CORS large en dev. En prod, restreindre aux domaines Library :
#   CORS(app, origins=["https://somatica-library.netlify.app", "http://localhost:5173"])
CORS(app, resources={r"/*": {"origins": "*"}})

facedb = FaceDBSupabase(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# État des jobs en cours (en mémoire, non persisté - import_log garde la trace persistante)
JOBS = {}


@app.before_request
def auth_check():
    if request.path == "/health" or request.method == "OPTIONS":
        return None
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if token != WORKER_TOKEN:
        return jsonify({"error": "unauthorized"}), 401


# ---------------------------------------------------------------------------
# Helpers import_log
# ---------------------------------------------------------------------------

def log_start(run_type: str, details: dict) -> str:
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/import_log",
        headers={**SB_HEADERS, "Prefer": "return=representation"},
        json={"run_type": run_type, "status": "running", "details": details},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()[0]["id"]


def log_finish(log_id: str, status: str, details: dict = None, error: str = None):
    payload = {
        "status": status,
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }
    if details:
        payload["items_processed"] = int(details.get("processed", 0))
        payload["items_added"] = int(details.get("added", 0))
        payload["items_skipped"] = int(details.get("skipped", 0))
        payload["items_failed"] = int(details.get("failed", 0))
        payload["details"] = details
    if error:
        payload["error"] = error[:2000]
    requests.patch(
        f"{SUPABASE_URL}/rest/v1/import_log",
        params={"id": f"eq.{log_id}"},
        headers=SB_HEADERS,
        json=payload,
        timeout=15,
    )


def get_setting(key: str, default=None):
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/library_settings",
        params={"key": f"eq.{key}", "select": "value"},
        headers=SB_HEADERS,
        timeout=15,
    )
    rows = resp.json()
    return rows[0]["value"] if rows else default


def set_setting(key: str, value):
    requests.post(
        f"{SUPABASE_URL}/rest/v1/library_settings",
        params={"on_conflict": "key"},
        headers={
            **SB_HEADERS,
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        json={
            "key": key,
            "value": value,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        timeout=15,
    )


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.route("/health")
def health():
    return {
        "ok": True,
        "service": "somatica-library-worker",
        "ts": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# iCloud albums + sync
# ---------------------------------------------------------------------------

@app.route("/icloud/albums")
def icloud_albums():
    """Liste les albums iCloud contenant au moins une vidéo."""
    try:
        import osxphotos
    except ImportError:
        return {"error": "osxphotos non installé. pip install osxphotos"}, 500

    try:
        db = osxphotos.PhotosDB()
        current = get_setting("icloud_sync_album")

        albums = []
        for album in db.album_info:
            try:
                photos = album.photos
            except Exception:
                continue
            videos = [p for p in photos if p.ismovie]
            if not videos:
                continue
            title = album.title or "(sans nom)"
            albums.append({
                "name": title,
                "uuid": album.uuid,
                "video_count": len(videos),
                "is_current": title == current,
            })
        albums.sort(key=lambda a: (-a["video_count"], a["name"].lower()))
        return {"albums": albums, "current_album": current}
    except Exception as e:
        return {"error": str(e), "traceback": traceback.format_exc()}, 500


@app.route("/icloud/sync", methods=["POST"])
def icloud_sync():
    """Lance une synchro iCloud en arrière-plan (non bloquante)."""
    data = request.get_json(silent=True) or {}
    album = data.get("album") or get_setting("icloud_sync_album")
    limit = int(data.get("limit", 0))
    if not album:
        return {"error": "Aucun album selectionne dans library_settings"}, 400

    job_id = f"sync_{int(time.time())}"
    JOBS[job_id] = {"type": "icloud_sync", "status": "running", "started_at": time.time()}
    thread = threading.Thread(target=_run_icloud_sync, args=(job_id, album, limit))
    thread.daemon = True
    thread.start()
    return {"job_id": job_id, "album": album, "limit": limit}


def _run_icloud_sync(job_id: str, album: str, limit: int):
    log_id = log_start("icloud_sync", {"album": album, "limit": limit})
    try:
        import icloud_sync

        result = icloud_sync.sync_album(
            album_name=album,
            supabase_url=SUPABASE_URL,
            service_role_key=SUPABASE_SERVICE_ROLE_KEY,
            store_token=STORE_BACKGROUND_TOKEN,
            limit=limit,
        )
        JOBS[job_id] = {"type": "icloud_sync", "status": "success", **result}
        log_finish(log_id, "success", result)
        set_setting("icloud_sync_last_run", datetime.now(timezone.utc).isoformat())
    except Exception as e:
        JOBS[job_id] = {
            "type": "icloud_sync",
            "status": "error",
            "error": str(e),
            "traceback": traceback.format_exc(),
        }
        log_finish(log_id, "error", None, error=str(e))


# ---------------------------------------------------------------------------
# Thumbnails
# ---------------------------------------------------------------------------

@app.route("/thumbnails/check")
def thumbnails_check():
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/video_library",
        params={
            "select": "id,file_name",
            "thumbnail_url": "is.null",
            "r2_url": "not.is.null",
            "order": "created_at.desc",
        },
        headers=SB_HEADERS,
        timeout=30,
    )
    rows = resp.json()
    return {
        "missing_count": len(rows),
        "sample": rows[:10],
    }


@app.route("/thumbnails/backfill", methods=["POST"])
def thumbnails_backfill():
    data = request.get_json(silent=True) or {}
    limit = int(data.get("limit", 0))
    redo = bool(data.get("redo", False))
    job_id = f"thumb_{int(time.time())}"
    JOBS[job_id] = {"type": "thumbnails_backfill", "status": "running", "started_at": time.time()}
    thread = threading.Thread(target=_run_thumbnail_backfill, args=(job_id, limit, redo))
    thread.daemon = True
    thread.start()
    return {"job_id": job_id, "limit": limit, "redo": redo}


def _run_thumbnail_backfill(job_id: str, limit: int, redo: bool = False):
    import subprocess
    log_id = log_start("thumbnail_backfill", {"limit": limit, "redo": redo})
    try:
        cmd = [sys.executable, str(HERE / "generate_thumbnails.py")]
        if limit:
            cmd.extend(["--limit", str(limit)])
        if redo:
            cmd.append("--redo")
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        output = (proc.stdout or "")[-4000:]
        stderr = (proc.stderr or "")[-1000:]
        status = "success" if proc.returncode == 0 else "error"
        JOBS[job_id] = {
            "type": "thumbnails_backfill",
            "status": status,
            "return_code": proc.returncode,
            "output_tail": output,
            "stderr_tail": stderr,
        }
        log_finish(log_id, status, {"output_tail": output, "stderr_tail": stderr})
    except Exception as e:
        JOBS[job_id] = {
            "type": "thumbnails_backfill",
            "status": "error",
            "error": str(e),
        }
        log_finish(log_id, "error", None, error=str(e))


# ---------------------------------------------------------------------------
# Face recognition
# ---------------------------------------------------------------------------

@app.route("/faces/build", methods=["POST"])
def faces_build():
    job_id = f"build_{int(time.time())}"
    JOBS[job_id] = {"type": "face_build", "status": "running", "started_at": time.time()}
    thread = threading.Thread(target=_run_faces_build, args=(job_id,))
    thread.daemon = True
    thread.start()
    return {"job_id": job_id}


def _run_faces_build(job_id: str):
    log_id = log_start("face_build", {})
    try:
        import face_recognition_pass
        result = face_recognition_pass.build_phase(
            facedb=facedb,
            supabase_url=SUPABASE_URL,
            service_role_key=SUPABASE_SERVICE_ROLE_KEY,
        )
        JOBS[job_id] = {"type": "face_build", "status": "success", **result}
        log_finish(log_id, "success", result)
    except Exception as e:
        JOBS[job_id] = {
            "type": "face_build",
            "status": "error",
            "error": str(e),
            "traceback": traceback.format_exc(),
        }
        log_finish(log_id, "error", None, error=str(e))


@app.route("/faces/match", methods=["POST"])
def faces_match():
    data = request.get_json(silent=True) or {}
    limit = int(data.get("limit", 0))
    tolerance = float(data.get("tolerance") or get_setting("face_recognition_tolerance", 0.6))
    job_id = f"match_{int(time.time())}"
    JOBS[job_id] = {"type": "face_match", "status": "running", "started_at": time.time()}
    thread = threading.Thread(target=_run_faces_match, args=(job_id, limit, tolerance))
    thread.daemon = True
    thread.start()
    return {"job_id": job_id, "limit": limit, "tolerance": tolerance}


def _run_faces_match(job_id: str, limit: int, tolerance: float):
    log_id = log_start("face_match", {"limit": limit, "tolerance": tolerance})
    try:
        import face_recognition_pass
        result = face_recognition_pass.match_phase(
            facedb=facedb,
            supabase_url=SUPABASE_URL,
            service_role_key=SUPABASE_SERVICE_ROLE_KEY,
            limit=limit,
            tolerance=tolerance,
        )
        JOBS[job_id] = {"type": "face_match", "status": "success", **result}
        log_finish(log_id, "success", result)
    except Exception as e:
        JOBS[job_id] = {
            "type": "face_match",
            "status": "error",
            "error": str(e),
            "traceback": traceback.format_exc(),
        }
        log_finish(log_id, "error", None, error=str(e))


@app.route("/faces/clusters")
def faces_clusters():
    """Liste tous les clusters avec les URLs de thumbnails associées."""
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/face_clusters",
        params={
            "select": "cluster_name,is_named,sample_count,sample_video_ids,updated_at",
            "order": "is_named.asc,sample_count.desc",
        },
        headers=SB_HEADERS,
        timeout=30,
    )
    clusters = resp.json()

    for row in clusters:
        video_ids = (row.get("sample_video_ids") or [])[:6]
        thumbs = []
        if video_ids:
            vid_resp = requests.get(
                f"{SUPABASE_URL}/rest/v1/video_library",
                params={
                    "id": f"in.({','.join(video_ids)})",
                    "select": "id,thumbnail_url,file_name",
                },
                headers=SB_HEADERS,
                timeout=15,
            )
            thumbs = [v for v in vid_resp.json() if v.get("thumbnail_url")]
        row["thumbnails"] = thumbs
    return {"clusters": clusters, "total": len(clusters)}


@app.route("/faces/rename", methods=["POST"])
def faces_rename():
    data = request.get_json()
    old_name = (data or {}).get("old_name", "").strip()
    new_name = (data or {}).get("new_name", "").strip()
    if not old_name or not new_name:
        return {"error": "old_name et new_name requis"}, 400
    if old_name == new_name:
        return {"error": "old_name et new_name identiques"}, 400

    try:
        result = facedb.rename(old_name, new_name)
        updated = _rename_in_video_library(old_name, new_name)
        return {
            "ok": True,
            "merged": result["merged"],
            "sample_count": result["sample_count"],
            "videos_updated": updated,
        }
    except Exception as e:
        return {"error": str(e), "traceback": traceback.format_exc()}, 500


def _rename_in_video_library(old_name: str, new_name: str) -> int:
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/video_library",
        params={
            "select": "id,persons_detected",
            "persons_detected": f"cs.{{\"{old_name}\"}}",
        },
        headers=SB_HEADERS,
        timeout=30,
    )
    videos = resp.json() if isinstance(resp.json(), list) else []
    count = 0
    for v in videos:
        persons = v.get("persons_detected") or []
        new_persons = []
        for p in persons:
            target = new_name if p == old_name else p
            if target not in new_persons:
                new_persons.append(target)
        if new_persons != persons:
            requests.patch(
                f"{SUPABASE_URL}/rest/v1/video_library",
                params={"id": f"eq.{v['id']}"},
                headers=SB_HEADERS,
                json={"persons_detected": new_persons},
                timeout=15,
            )
            count += 1
    return count


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

@app.route("/settings/<key>", methods=["GET", "PUT"])
def settings(key):
    if request.method == "GET":
        value = get_setting(key)
        return {"key": key, "value": value}
    data = request.get_json() or {}
    if "value" not in data:
        return {"error": "value requis"}, 400
    set_setting(key, data["value"])
    return {"ok": True, "key": key, "value": data["value"]}


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

@app.route("/jobs/<job_id>")
def job_status(job_id):
    job = JOBS.get(job_id)
    if not job:
        return {"error": "job inconnu"}, 404
    return job


@app.route("/jobs")
def jobs_list():
    return {"jobs": JOBS}


@app.route("/status/last-runs")
def last_runs():
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/import_log",
        params={"select": "*", "order": "started_at.desc", "limit": "20"},
        headers=SB_HEADERS,
        timeout=30,
    )
    return {"runs": resp.json()}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print(f"Somatica Library Worker - port {WORKER_PORT}")
    print(f"  Token : {'set' if WORKER_TOKEN else 'MISSING'}")
    print(f"  Supabase : {SUPABASE_URL}")
    print()
    print("Test rapide :")
    print(f"  curl http://localhost:{WORKER_PORT}/health")
    print()
    app.run(host="0.0.0.0", port=WORKER_PORT, debug=False)
