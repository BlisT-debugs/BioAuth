// Simple keystroke dynamics capture: dwell time and flight time

const passwordInput = document.getElementById('password');
const usernameInput = document.getElementById('username');
const statusEl = document.getElementById('status');
const loginForm = document.getElementById('login-form');
const loginBtn = document.getElementById('login-btn');
const perimeterChip = document.getElementById('perimeter-mode');
const hintText = document.getElementById('hint-text');

let keyDownTimes = {};
let dwellTimes = [];
let flightTimes = [];
let lastKeyUpTime = null;
let perimeterMode = 'internal';

async function measureLatencies() {
    const samples = [];
    for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        await fetch('/api/perimeter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: usernameInput.value || null,
                latencies_ms: [] // first call: just to get IP-based decision
            })
        });
        const dt = performance.now() - t0;
        samples.push(dt);
    }
    return samples;
}

async function initPerimeter() {
    try {
        const latencies = await measureLatencies();
        const res = await fetch('/api/perimeter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: usernameInput.value || null,
                latencies_ms: latencies
            })
        });
        const data = await res.json();
        perimeterMode = data.mode;
        if (perimeterMode === 'remote') {
            perimeterChip.textContent = 'Remote / VPN – multi-modal';
            hintText.textContent = 'Remote network detected. Face authentication may be required.';
        } else {
            perimeterChip.textContent = 'Internal network';
            hintText.textContent = 'Internal network detected. Keystroke behavior may be enough.';
        }
    } catch (e) {
        perimeterChip.textContent = 'Perimeter unknown';
    }
}

window.addEventListener('load', () => {
    initPerimeter();
});

passwordInput.addEventListener('input', (e) => {
    if (passwordInput.value === '') {
        dwellTimes = [];
        flightTimes = [];
        keyDownTimes = {};
        lastKeyUpTime = null;
    }
});

passwordInput.addEventListener('keydown', (e) => {
    if (e.repeat || e.key === 'Enter') return;
    keyDownTimes[e.code] = performance.now();
});

passwordInput.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') return;
    const now = performance.now();
    const downTime = keyDownTimes[e.code];
    if (downTime) {
        dwellTimes.push(now - downTime);
    }
    if (lastKeyUpTime !== null) {
        flightTimes.push(now - lastKeyUpTime);
    }
    lastKeyUpTime = now;
});

async function submitKeystrokes(username, password) {
    const timings = dwellTimes.concat(flightTimes);
    const res = await fetch('/api/keystrokes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, timings })
    });
    return res.json();
}

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = usernameInput.value.trim();
    if (!username) return;

    const password = passwordInput.value;
    if (!password) {
        statusEl.textContent = 'Please enter your password.';
        return;
    }

    loginBtn.disabled = true;
    statusEl.textContent = 'Analyzing keystroke behavior…';

    try {
        const result = await submitKeystrokes(username, password);
        if (result.result === 'granted') {
            statusEl.textContent = `Access granted (Z-score ${result.z_score?.toFixed(2) ?? 'n/a'}).`;
            window.location.href = '/high-clearance';
        } else if (result.result === 'step_up') {
            statusEl.textContent = `Behavioral mismatch (Z-score ${result.z_score?.toFixed(2) ?? 'n/a'}). Starting face verification…`;
            await startFaceFlow(username);
        } else if (result.error) {
            statusEl.textContent = `Error: ${result.error}`;
        }
    } catch (err) {
        console.error(err);
        statusEl.textContent = 'Error during authentication.';
    } finally {
        loginBtn.disabled = false;
    }
});

