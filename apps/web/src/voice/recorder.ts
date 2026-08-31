/**
 * Browser voice recorder (PR 8, task 8.3).
 *
 * Wraps MediaRecorder + getUserMedia behind the injectable `VoiceRecorder`
 * interface so App.tsx stays testable. Returns null when the browser offers
 * no recording API — the UI hides the control then.
 */

export interface RecordedAudio {
  audio: Uint8Array;
  mimeType: string;
}

export interface VoiceRecorder {
  /** Requests the microphone and starts recording. */
  startRecording(): Promise<void>;
  /** Stops the active recording and resolves with the encoded audio. */
  stopRecording(): Promise<RecordedAudio>;
}

export function createBrowserVoiceRecorder(): VoiceRecorder | null {
  if (
    typeof window === 'undefined' ||
    typeof MediaRecorder === 'undefined' ||
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    return null;
  }

  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];

  return {
    startRecording(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        navigator.mediaDevices
          .getUserMedia({ audio: true })
          .then((mediaStream) => {
            stream = mediaStream;
            chunks = [];
            const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : undefined;
            recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
            recorder.ondataavailable = (event: BlobEvent) => {
              if (event.data.size > 0) {
                chunks.push(event.data);
              }
            };
            recorder.start();
            resolve();
          })
          .catch(reject);
      });
    },

    stopRecording(): Promise<RecordedAudio> {
      return new Promise<RecordedAudio>((resolve, reject) => {
        const current = recorder;
        if (current === null) {
          reject(new Error('No active recording'));
          return;
        }
        current.onstop = () => {
          stream?.getTracks().forEach((track) => track.stop());
          const blob = new Blob(chunks, { type: current.mimeType || 'audio/webm' });
          void blob
            .arrayBuffer()
            .then((buffer) => {
              resolve({ audio: new Uint8Array(buffer), mimeType: blob.type || 'audio/webm' });
            })
            .catch(reject);
        };
        current.stop();
      });
    },
  };
}
