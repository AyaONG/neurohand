import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

export async function initTracker(): Promise<HandLandmarker> {
  const vision = await FilesetResolver.forVisionTasks("/wasm");
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: "/models/hand_landmarker.task", delegate: "GPU" },
    runningMode: "VIDEO", numHands: 1,
    minHandDetectionConfidence: 0.6, minTrackingConfidence: 0.6,
  });
}

export async function initCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, facingMode: "user" }, audio: false,
  });
  video.srcObject = stream;
  try {
    await video.play();
    return stream;
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    video.srcObject = null;
    throw error;
  }
}
