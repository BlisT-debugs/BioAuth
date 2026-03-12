// Registration & enrollment: capture keystroke timings + face descriptor with liveness

const regForm = document.getElementById('register-form');
const regUsername = document.getElementById('username');
const regPassword = document.getElementById('password');
const regStatus = document.getElementById('status');
const regBtn = document.getElementById('register-btn');

let regKeyDownTimes = {};
let regDwellTimes = [];
let regFlightTimes = [];
let regLastKeyUp = null;
const regTimingSamples = [];
let regStoredPassword = null;

regPassword.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    regKeyDownTimes[e.code] = performance.now();
});

regPassword.addEventListener('keyup', (e) => {
    const now = performance.now();
    const downTime = regKeyDownTimes[e.code];
    if (downTime) {
        regDwellTimes.push(now - downTime);
    }
    if (regLastKeyUp !== null) {
        regFlightTimes.push(now - regLastKeyUp);
    }
    regLastKeyUp = now;
});

regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = regUsername.value.trim();
    const currentPassword = regPassword.value;
    if (!username || (!currentPassword && !regStoredPassword)) return;

    const timings = regDwellTimes.concat(regFlightTimes);
    if (!timings.length) {
        regStatus.textContent = 'Please type your password so we can capture your keystroke rhythm.';
        return;
    }

    // On first sample, lock in the password value we will actually register with
    if (regStoredPassword === null) {
        regStoredPassword = currentPassword;
    }

    // Record this sample
    regTimingSamples.push(timings);
    const sampleCount = regTimingSamples.length;

    // Reset per-sample timing buffers for the next typing
    regKeyDownTimes = {};
    regDwellTimes = [];
    regFlightTimes = [];
    regLastKeyUp = null;
    // Clear the visible password field so user doesn't need to backspace
    regPassword.value = '';

    if (sampleCount < 3) {
        regStatus.textContent = `Captured sample ${sampleCount}/3. Please type your password again in the same way.`;
        return;
    }

    regBtn.disabled = true;
    regStatus.textContent = 'Starting camera for liveness enrollment…';

    try {
        // Uses collectBlinkAndDescriptor from face_liveness.js
        const { descriptor, liveness_passed } = await collectBlinkAndDescriptor(username);
        regStatus.textContent = 'Saving enrollment securely…';
        const res = await fetch('/api/register/enroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                password: regStoredPassword,
                timings_samples: regTimingSamples,
                descriptor,
                liveness_passed
            }),
        });
        const data = await res.json();
        if (!res.ok) {
            regStatus.textContent = `Registration failed: ${data.error || 'unknown error'}`;
            regBtn.disabled = false;
            return;
        }
        regStatus.textContent = 'Enrollment complete. Redirecting to login…';
        setTimeout(() => {
            window.location.href = '/';
        }, 1000);
    } catch (err) {
        console.error(err);
        regStatus.textContent = err.message || 'Error during enrollment.';
        regBtn.disabled = false;
    }
});

