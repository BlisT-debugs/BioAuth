// Face liveness + 128-d descriptor capture using face-api.js
// Liveness detector using Head Yaw Pattern Matching

const videoEl = document.getElementById('camera');
let faceModelsLoaded = false;

async function loadFaceModels() {
    if (faceModelsLoaded) return;
    const MODEL_URL = '/static/models';
    await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    faceModelsLoaded = true;
}

// Calculate Head Yaw (Horizontal rotation)
function computeHeadYaw(landmarks) {
    const positions = landmarks.positions;
    const noseX = positions[30].x;
    const leftJawX = positions[0].x;
    const rightJawX = positions[16].x;
    
    const faceWidth = rightJawX - leftJawX;
    if (faceWidth === 0) return 0.5; 
    
    return (noseX - leftJawX) / faceWidth;
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

async function collectLivenessAndDescriptor(username) {
    // 1. Generate a random pattern of 3 or 4 moves
    const patternLength = Math.floor(Math.random() * 2) + 3; 
    const dirs = ['Left', 'Right'];
    const pattern = Array.from({length: patternLength}, () => dirs[Math.floor(Math.random() * 2)]);
    let currentStep = 0;

    const statusEl = document.getElementById('status');
    
    // UI Helper to render the sequence visually
    const renderUI = (message, highlightColor) => {
        if (!statusEl) return;
        
        const patternHTML = pattern.map((dir, idx) => {
            if (idx < currentStep) return `<span style="color: #22c55e; text-decoration: line-through; margin: 0 4px;">${dir}</span>`;
            if (idx === currentStep) return `<span style="color: #fbbf24; font-weight: bold; border-bottom: 2px solid #fbbf24; margin: 0 4px;">${dir}</span>`;
            return `<span style="color: #6b7280; margin: 0 4px;">${dir}</span>`;
        }).join(' &rarr; ');

        statusEl.innerHTML = `
            <div style="font-size: 0.95rem; color: #d1d5db; margin-bottom: 0.5rem;">LIVENESS CHECK: Follow the pattern</div>
            <div style="font-size: 1.1rem; margin-bottom: 0.5rem; background: rgba(31, 41, 55, 0.7); padding: 0.5rem; border-radius: 0.5rem; text-align: center;">
                ${patternHTML}
            </div>
            <div style="color: ${highlightColor}; font-weight: bold; font-size: 1rem;">${message}</div>
        `;
    };

    renderUI("Starting camera...", "#9ca3af");

    await loadFaceModels();
    await startCamera();

    const WINDOW_MS = 25000; // 25 seconds to complete the pattern
    let startTime = performance.now();
    let descriptor = null;
    
    // Dynamic tracking variables
    let isCenter = true; // Forces user to look center between turns
    let baselineYaw = null;
    let frameCount = 0;

    return new Promise((resolve, reject) => {
        async function step() {
            const now = performance.now();
            
            if (now - startTime > WINDOW_MS && currentStep < pattern.length) {
                stopCamera();
                reject(new Error("Liveness failed: Pattern not completed in time."));
                return;
            }

            const detection = await faceapi
                .detectSingleFace(videoEl)
                .withFaceLandmarks()
                .withFaceDescriptor();

            if (detection) {
                descriptor = Array.from(detection.descriptor);
                const yaw = computeHeadYaw(detection.landmarks);
                
                // Establish a straight-facing baseline over 5 frames
                if (frameCount < 5) {
                    baselineYaw = (baselineYaw === null) ? yaw : (baselineYaw + yaw) / 2;
                    frameCount++;
                    renderUI("Look straight at the camera to calibrate...", "#fbbf24");
                } else {
                    const currentTarget = pattern[currentStep];
                    
                    // Define thresholds relative to their specific resting face
                    const lookLeftThreshold = baselineYaw - 0.12;
                    const lookRightThreshold = baselineYaw + 0.12;
                    const centerMargin = 0.05;

                    let currentLook = 'Center';
                    //Swapped Left and Right to account for webcam mirroring
                    if (yaw < lookLeftThreshold) currentLook = 'Right';
                    if (yaw > lookRightThreshold) currentLook = 'Left';
                    if (Math.abs(yaw - baselineYaw) < centerMargin) currentLook = 'Center';

                    if (isCenter) {
                        if (currentLook === currentTarget) {
                            // Hit the target!
                            currentStep++;
                            isCenter = false; // Lock out until they look back to center
                            
                            if (currentStep < pattern.length) {
                                renderUI("Great! Now look straight ahead.", "#22c55e");
                            }
                        } else {
                            renderUI(`Turn your head ${currentTarget}`, "#fbbf24");
                        }
                    } else {
                        // User just completed a turn, they must look center before next step
                        if (currentLook === 'Center') {
                            isCenter = true;
                            if (currentStep < pattern.length) {
                                renderUI(`Next: Turn ${pattern[currentStep]}`, "#fbbf24");
                            }
                        } else {
                            renderUI("Please look back at the center first.", "#ef4444");
                        }
                    }
                }
            }

            // If pattern is complete and they returned to center
            if (currentStep >= pattern.length && isCenter && descriptor) {
                renderUI("Pattern complete!", "#22c55e");
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
        
        // collectLivenessAndDescriptor now handles the pattern generation internally
        const { descriptor, liveness_passed } = await collectLivenessAndDescriptor(username);
        
        statusEl.textContent = 'Liveness passed! Verifying face on server…';
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