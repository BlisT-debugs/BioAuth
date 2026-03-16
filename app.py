import ipaddress
import json
import os
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Tuple, Optional

import numpy as np
from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import generate_password_hash, check_password_hash

DB_PATH = Path(os.environ.get("BIOAUTH_DB_PATH", "auth.db"))
INTERNAL_NETWORKS = [
    ipaddress.ip_network("59.152.80.69/32"),  # demo: treat it as internal
    ipaddress.ip_network("127.0.0.0/8"),    # treat localhost as internal for testing
]
Z_THRESHOLD = 1.6
FACE_DISTANCE_THRESHOLD = 0.6


app = Flask(__name__)
# Secret key should come from environment in production
app.secret_key = os.environ.get("BIOAUTH_SECRET_KEY", "dev-insecure-key")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    cur = conn.cursor()

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        );
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS keystroke_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            mu TEXT NOT NULL,
            sigma TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS face_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            descriptor TEXT NOT NULL,
            created_at REAL NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            username TEXT,
            event_type TEXT NOT NULL,
            detail TEXT,
            is_remote INTEGER NOT NULL,
            created_at REAL NOT NULL
        );
        """
    )

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS high_clearance_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        """
    )

    # Ensure we can upsert by user_id in keystroke_profiles
    cur.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_keystroke_user ON keystroke_profiles(user_id);"
    )

    conn.commit()
    conn.close()


def ip_is_internal(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in INTERNAL_NETWORKS)


def classify_connection(latencies_ms: List[float]) -> str:
    """
    Very simple heuristic: high average latency and jitter -> treat as VPN/untrusted.
    """
    if not latencies_ms:
        return "unknown"

    arr = np.array(latencies_ms, dtype=float)
    mean = float(arr.mean())
    std = float(arr.std())

    if mean > 180 or std > 60:
        return "vpn"
    if mean < 80 and std < 30:
        return "trusted"
    return "unknown"


@dataclass
class GaussianProfile:
    mu: np.ndarray
    sigma: np.ndarray

    @classmethod
    def from_strings(cls, mu_str: str, sigma_str: str) -> "GaussianProfile":
        return cls(
            mu=np.array(json.loads(mu_str), dtype=float),
            sigma=np.array(json.loads(sigma_str), dtype=float),
        )

    def to_strings(self) -> Tuple[str, str]:
        return json.dumps(self.mu.tolist()), json.dumps(self.sigma.tolist())


def gaussian_z_score(x: np.ndarray, profile: GaussianProfile) -> float:
    eps = 1e-6
    z = np.abs(x - profile.mu) / (profile.sigma + eps)
    return float(z.mean())


def update_gaussian_profile(profile: GaussianProfile, x: np.ndarray, alpha: float = 0.18) -> GaussianProfile:
    mu_new = profile.mu * (1.0 - alpha) + x * alpha
    # keep sigma as-is for simplicity; could also adapt
    return GaussianProfile(mu=mu_new, sigma=profile.sigma)


def get_user_by_username(username: str) -> Optional[sqlite3.Row]:
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM users WHERE username = ?", (username,))
    row = cur.fetchone()
    conn.close()
    return row


def get_keystroke_profile(user_id: int) -> Optional[GaussianProfile]:
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM keystroke_profiles WHERE user_id = ?", (user_id,))
    row = cur.fetchone()
    conn.close()
    if row is None:
        return None
    return GaussianProfile.from_strings(row["mu"], row["sigma"])


def save_keystroke_profile(user_id: int, profile: GaussianProfile):
    mu_str, sigma_str = profile.to_strings()
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO keystroke_profiles (user_id, mu, sigma)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            mu = excluded.mu,
            sigma = excluded.sigma;
        """,
        (user_id, mu_str, sigma_str),
    )
    conn.commit()
    conn.close()


def get_face_templates(user_id: int) -> List[np.ndarray]:
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT descriptor FROM face_templates WHERE user_id = ?", (user_id,))
    rows = cur.fetchall()
    conn.close()
    descriptors = []
    for r in rows:
        vec = np.array(json.loads(r["descriptor"]), dtype=float)
        descriptors.append(vec)
    return descriptors


def log_event(user_id: Optional[int], username: Optional[str], event_type: str, detail: dict, is_remote: bool):
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO audit_logs (user_id, username, event_type, detail, is_remote, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (user_id, username, event_type, json.dumps(detail), int(is_remote), time.time()),
    )
    conn.commit()
    conn.close()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/register")
def register():
    return render_template("register.html")

@app.route("/high-clearance")
def high_clearance():
    if "user_id" not in session:
        return redirect(url_for("index"))
    return render_template("high_clearance.html")


@app.route("/admin")
def admin_dashboard():
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "SELECT * FROM high_clearance_requests WHERE status = 'pending' ORDER BY created_at DESC"
    )
    pending = cur.fetchall()
    conn.close()
    return render_template("admin.html", pending=pending)


@app.post("/api/perimeter")
def api_perimeter():
    """
    Step 1: Perimeter security.
    Client sends optional measured latencies; server also inspects IP.
    """
    data = request.get_json(force=True)
    username = data.get("username")
    latencies = data.get("latencies_ms") or []

    if request.headers.getlist("X-Forwarded-For"):
        ip = request.headers.getlist("X-Forwarded-For")[0]
    else:
        ip = request.remote_addr or "0.0.0.0"
    internal = ip_is_internal(ip)
    classification = classify_connection(latencies)

    is_remote = not internal or classification == "vpn"

    log_event(
        user_id=None,
        username=username,
        event_type="perimeter_check",
        detail={"ip": ip, "internal": internal, "latency_class": classification},
        is_remote=is_remote,
    )

    # Remote/VPN -> force multi-modal (face + password)
    mode = "remote" if is_remote else "internal"
    return jsonify({"mode": mode})


@app.post("/api/keystrokes")
def api_keystrokes():
    """
    Step 2: Behavioral engine (keystroke dynamics).
    Expects dwell/flight timings as a flat array.
    """
    data = request.get_json(force=True)
    username = data.get("username")
    password = data.get("password")
    timings = data.get("timings") or []

    user = get_user_by_username(username)
    if user is None:
        return jsonify({"error": "unknown user"}), 400

    if not password or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "invalid_credentials"}), 401

    x = np.array(timings, dtype=float)
    profile = get_keystroke_profile(user["id"])

    if profile is None:
        # First successful login will establish baseline; for now, require face step-up
        z = None
        match = False
    else:
        z = gaussian_z_score(x, profile)
        match = z < Z_THRESHOLD

    is_remote = not ip_is_internal(request.remote_addr or "0.0.0.0")
    log_event(
        user_id=user["id"],
        username=username,
        event_type="keystroke_check",
        detail={"z_score": z, "timing_len": len(timings)},
        is_remote=is_remote,
    )

    if match:
        # Adaptive learning: update mean on successful login
        new_profile = update_gaussian_profile(profile, x)
        save_keystroke_profile(user["id"], new_profile)
        session["user_id"] = user["id"]
        session["username"] = username
        return jsonify({"result": "granted", "z_score": z})

    # Mismatch -> trigger step-up (face scan)
    return jsonify({"result": "step_up", "z_score": z})


@app.post("/api/face-verify")
def api_face_verify():
    """
    Step 3: Physiological engine (facial liveness + identity).
    Expects:
      - username
      - descriptor: 128-dim vector
      - liveness_passed: bool (blink sequence verified client-side)
    """
    data = request.get_json(force=True)
    username = data.get("username")
    descriptor = data.get("descriptor")
    liveness_passed = bool(data.get("liveness_passed"))

    if not liveness_passed:
        return jsonify({"error": "liveness_failed"}), 400

    user = get_user_by_username(username)
    if user is None:
        return jsonify({"error": "unknown user"}), 400

    desc_vec = np.array(descriptor, dtype=float)
    templates = get_face_templates(user["id"])

    if not templates:
        # First successful capture will become baseline after verification
        distance = 0.0
        match = True
    else:
        distances = [float(np.linalg.norm(desc_vec - t)) for t in templates]
        distance = min(distances)
        match = distance < FACE_DISTANCE_THRESHOLD

    is_remote = not ip_is_internal(request.remote_addr or "0.0.0.0")
    log_event(
        user_id=user["id"],
        username=username,
        event_type="face_check",
        detail={"distance": distance, "liveness_passed": liveness_passed},
        is_remote=is_remote,
    )

    if not match:
        return jsonify({"result": "rejected", "distance": distance}), 403

    # Multi-template approach: store new descriptor too to adapt over time
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO face_templates (user_id, descriptor, created_at) VALUES (?, ?, ?)",
        (user["id"], json.dumps(desc_vec.tolist()), time.time()),
    )
    conn.commit()
    conn.close()

    session["user_id"] = user["id"]
    session["username"] = username
    return jsonify({"result": "granted", "distance": distance})


@app.post("/api/high-clearance/request")
def api_high_clearance_request():
    if "user_id" not in session:
        return jsonify({"error": "not_authenticated"}), 401

    user_id = session["user_id"]
    username = session["username"]

    conn = get_db()
    cur = conn.cursor()
    now = time.time()
    cur.execute(
        """
        INSERT INTO high_clearance_requests (user_id, username, status, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?)
        """,
        (user_id, username, now, now),
    )
    req_id = cur.lastrowid
    conn.commit()
    conn.close()

    log_event(
        user_id=user_id,
        username=username,
        event_type="high_clearance_requested",
        detail={"request_id": req_id},
        is_remote=not ip_is_internal(request.remote_addr or "0.0.0.0"),
    )

    return jsonify({"request_id": req_id})


@app.get("/api/high-clearance/status/<int:req_id>")
def api_high_clearance_status(req_id: int):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT status FROM high_clearance_requests WHERE id = ?", (req_id,))
    row = cur.fetchone()
    conn.close()

    if row is None:
        return jsonify({"error": "not_found"}), 404

    return jsonify({"status": row["status"]})


@app.post("/api/admin/approve/<int:req_id>")
def api_admin_approve(req_id: int):
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "UPDATE high_clearance_requests SET status = 'approved', updated_at = ? WHERE id = ?",
        (time.time(), req_id),
    )
    conn.commit()
    conn.close()
    return jsonify({"status": "approved"})


@app.post("/api/admin/deny/<int:req_id>")
def api_admin_deny(req_id: int):
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "UPDATE high_clearance_requests SET status = 'denied', updated_at = ? WHERE id = ?",
        (time.time(), req_id),
    )
    conn.commit()
    conn.close()
    return jsonify({"status": "denied"})


@app.post("/api/register/enroll")
def api_register_enroll():
    """
    Create a new user and enroll baseline keystroke profile + initial face template.
    Expects:
      - username
      - password (plain, hashed server-side)
      - timings_samples: list of dwell/flight time arrays (recommended: 3 samples)
        OR legacy: timings: single dwell/flight times array
      - descriptor: 128-dim face descriptor
      - liveness_passed: bool
    """
    data = request.get_json(force=True)
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    timings_samples = data.get("timings_samples")
    timings = data.get("timings") or []
    descriptor = data.get("descriptor")
    liveness_passed = bool(data.get("liveness_passed"))

    if not username or not password:
        return jsonify({"error": "username_and_password_required"}), 400
    if not liveness_passed or not descriptor:
        return jsonify({"error": "liveness_and_face_required"}), 400

    # Prefer multiple samples for better Gaussian profiling
    if timings_samples is not None:
        if not isinstance(timings_samples, list) or len(timings_samples) < 3:
            return jsonify({"error": "at_least_three_keystroke_samples_required"}), 400
        # Ensure all samples are non-empty; lengths may differ slightly due to minor input variation.
        lengths = [len(s or []) for s in timings_samples]
        if not all(lengths):
            return jsonify({"error": "keystroke_timings_required"}), 400
    else:
        if not timings:
            return jsonify({"error": "keystroke_timings_required"}), 400

    if get_user_by_username(username) is not None:
        return jsonify({"error": "user_exists"}), 409

    # Create user with hashed password
    pwd_hash = generate_password_hash(password)
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO users (username, password_hash) VALUES (?, ?)",
        (username, pwd_hash),
    )
    user_id = cur.lastrowid

    # Baseline Gaussian profile from samples:
    # If multiple samples provided, compute true mean/std over samples.
    if timings_samples is not None:
        # If samples have slightly different lengths (e.g. an extra key event),
        # trim all of them to the shortest length so we can build a consistent feature vector.
        lengths = [len(s) for s in timings_samples]
        min_len = min(lengths)
        trimmed_samples = [s[:min_len] for s in timings_samples]
        arr = np.array(trimmed_samples, dtype=float)  # shape: (n_samples, n_features)
        mu = arr.mean(axis=0)
        sigma = arr.std(axis=0)
        # Avoid zero-variance dimensions – add small floor
        sigma = np.where(sigma < 1.0, 1.0, sigma)
    else:
        x = np.array(timings, dtype=float)
        mu = x
        sigma = np.ones_like(x) * 50.0  # fallback when only one sample is available
    profile = GaussianProfile(mu=mu, sigma=sigma)
    mu_str, sigma_str = profile.to_strings()
    cur.execute(
        "INSERT INTO keystroke_profiles (user_id, mu, sigma) VALUES (?, ?, ?)",
        (user_id, mu_str, sigma_str),
    )

    # Initial face template
    desc_vec = np.array(descriptor, dtype=float)
    cur.execute(
        "INSERT INTO face_templates (user_id, descriptor, created_at) VALUES (?, ?, ?)",
        (user_id, json.dumps(desc_vec.tolist()), time.time()),
    )

    conn.commit()
    conn.close()

    log_event(
        user_id=user_id,
        username=username,
        event_type="user_registered",
        detail={"keystroke_len": len(timings)},
        is_remote=not ip_is_internal(request.remote_addr or "0.0.0.0"),
    )

    return jsonify({"result": "registered"})


if __name__ == "__main__":
    with app.app_context():
        init_db()
    # Debug mode is controlled via env; default is off for safer demo/production
    debug_mode = os.environ.get("BIOAUTH_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=int(os.environ.get("BIOAUTH_PORT", "5000")), debug=debug_mode)

