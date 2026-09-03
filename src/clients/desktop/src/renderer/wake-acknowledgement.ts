import type { DesktopRealtimeWakeAcknowledgementPlayer } from "./realtime.js";

export const wakeAcknowledgementText = "我在" as const;

const wakeAcknowledgementTimeoutMs = 1_200;

type SpeechSynthesisBoundary = Pick<SpeechSynthesis, "speak" | "cancel">;
type SpeechSynthesisUtteranceFactory = (text: string) => SpeechSynthesisUtterance;

function defaultSpeechSynthesis(): SpeechSynthesis | undefined {
  return typeof speechSynthesis === "undefined" ? undefined : speechSynthesis;
}

function defaultUtteranceFactory(text: string): SpeechSynthesisUtterance {
  if (typeof SpeechSynthesisUtterance === "undefined") {
    throw new Error("Speech synthesis is unavailable.");
  }
  return new SpeechSynthesisUtterance(text);
}

export function createBrowserWakeAcknowledgementPlayer(
  speech: SpeechSynthesisBoundary | undefined = defaultSpeechSynthesis(),
  createUtterance: SpeechSynthesisUtteranceFactory = defaultUtteranceFactory,
  timeoutMs = wakeAcknowledgementTimeoutMs
): DesktopRealtimeWakeAcknowledgementPlayer {
  let cancelActivePlayback: (() => void) | undefined;

  return {
    play: () => {
      if (!speech) {
        return Promise.resolve();
      }

      let utterance: SpeechSynthesisUtterance;
      try {
        utterance = createUtterance(wakeAcknowledgementText);
      } catch {
        return Promise.resolve();
      }

      return new Promise<void>(resolve => {
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          cancelActivePlayback = undefined;
          clearTimeout(timeout);
          resolve();
        };
        const cancel = (): void => {
          try {
            speech.cancel();
          } catch {
            // A failed cancellation must not strand the wake turn.
          }
          finish();
        };
        cancelActivePlayback = cancel;
        const timeout = setTimeout(cancel, Math.max(1, timeoutMs));

        utterance.lang = "zh-CN";
        utterance.rate = 1;
        utterance.volume = 1;
        utterance.onend = finish;
        utterance.onerror = finish;

        try {
          speech.speak(utterance);
        } catch {
          finish();
        }
      });
    },
    cancel: () => {
      cancelActivePlayback?.();
    }
  };
}
