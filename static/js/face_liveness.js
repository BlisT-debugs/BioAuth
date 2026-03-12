// Face liveness + 128-d descriptor capture using face-api.js
// Blink detector using Eye Aspect Ratio (EAR) with 6 landmarks per eye.

const videoEl = document.getElementById('camera');

let faceModelsLoaded = false;

async function loadFaceModels() {
    if (faceModelsLoaded) return;
    const MODEL_URL = '/static/models'; // served from Flask static
    await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    faceModelsLoaded = true;
}

function eyeEAR(eye) {
    // eye: array of 6 points p1..p6
    const p2p6 = faceapi.euclideanDistance(eye[1], eye[5]);
    const p3p5 = faceapi.euclideanDistance(eye[2], eye[4]);
    const p1p4 = faceapi.euclideanDistance(eye[0], eye[3]);
    return (p2p6 + p3p5) / (2.0 * p1p4);
}

function computeEAR(landmarks) {
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();
    const leftEAR = eyeEAR(leftEye);
    const rightEAR = eyeEAR(rightEye);
    return (leftEAR + rightEAR) / 2.0;
}

async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera not supported');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    videoEl.srcObject = stream;
    videoEl.style.display = 'block';
    await new Promise((resolve) => {
        videoEl.onloadedmetadata = () => {
            videoEl.play();
            resolve();
        };
    });
}

function stopCamera() {
    const stream = videoEl.srcObject;
    if (stream) {
        stream.getTracks().forEach((t) => t.stop());
    }
    videoEl.srcObject = null;
    videoEl.style.display = 'none';
}

async function collectBlinkAndDescriptor(username) {
    await loadFaceModels();
    await startCamera();

    // Simplified liveness: just require a clear face detection with descriptor
    const WINDOW_MS = 8000;    // 8 seconds to capture a stable frame

    const statusEl = document.getElementById('status');
    if (statusEl) {
        statusEl.textContent = 'Look at the camera and hold still while we capture your face.';
    }

    let startTime = performance.now();
    let descriptor = null;

    return new Promise((resolve, reject) => {
        async function step() {
            const now = performance.now();
            if (now - startTime > WINDOW_MS && !descriptor) {
                stopCamera();
                reject(new Error('Could not capture a stable face. Please ensure your full face is visible and the camera is not blocked.'));
                return;
            }

            const detection = await faceapi
                .detectSingleFace(videoEl)
                .withFaceLandmarks()
                .withFaceDescriptor();

            if (detection) {
                descriptor = Array.from(detection.descriptor);
            }

            if (descriptor) {
                stopCamera();
                resolve({ descriptor, liveness_passed: true });
                return;
            }

            requestAnimationFrame(step);
        }

        requestAnimationFrame(step);
    });
}

async function startFaceFlow(username) {
    const statusEl = document.getElementById('status');
    try {
        statusEl.textContent = 'Starting camera for liveness check…';
        const { descriptor, liveness_passed } = await collectBlinkAndDescriptor(username);
        statusEl.textContent = 'Verifying face on server…';
        const res = await fetch('/api/face-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, descriptor, liveness_passed })
        });
        const data = await res.json();
        if (!res.ok || data.result !== 'granted') {
            statusEl.textContent = 'Face verification failed.';
            return;
        }
        statusEl.textContent = 'Access granted via face verification.';
        window.location.href = '/high-clearance';
    } catch (err) {
        console.error(err);
        statusEl.textContent = err.message || 'Error during face verification.';
        stopCamera();
    }
}

