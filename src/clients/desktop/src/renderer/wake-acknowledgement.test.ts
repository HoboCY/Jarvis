import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createBrowserWakeAcknowledgementPlayer } from "./wake-acknowledgement.js";

test("browser wake acknowledgement speaks 我在 and completes when speech ends", async () => {
  let spoken: SpeechSynthesisUtterance | undefined;
  const speechSynthesis = {
    speak: (utterance: SpeechSynthesisUtterance) => {
      spoken = utterance;
    },
    cancel: () => undefined
  } as unknown as SpeechSynthesis;
  const player = createBrowserWakeAcknowledgementPlayer(
    speechSynthesis,
    text => ({
      text,
      lang: "",
      rate: 0,
      volume: 0,
      onend: null,
      onerror: null
    } as unknown as SpeechSynthesisUtterance),
    100
  );

  const playback = player.play();

  assert.equal(spoken?.text, "我在");
  assert.equal(spoken?.lang, "zh-CN");
  assert.equal(spoken?.rate, 1);
  assert.equal(spoken?.volume, 1);
  spoken?.onend?.(undefined as never);
  await playback;
});

test("browser wake acknowledgement completes when speech reports an error", async () => {
  let spoken: SpeechSynthesisUtterance | undefined;
  const speechSynthesis = {
    speak: (utterance: SpeechSynthesisUtterance) => {
      spoken = utterance;
    },
    cancel: () => undefined
  } as unknown as SpeechSynthesis;
  const player = createBrowserWakeAcknowledgementPlayer(
    speechSynthesis,
    () => ({ onend: null, onerror: null } as unknown as SpeechSynthesisUtterance),
    100
  );

  const playback = player.play();
  spoken?.onerror?.(undefined as never);

  await playback;
});

test("browser wake acknowledgement completes when speech synthesis is unavailable", async () => {
  const player = createBrowserWakeAcknowledgementPlayer(undefined);

  await player.play();
});

test("browser wake acknowledgement cancels speech when completion exceeds its bound", async () => {
  let cancelCalls = 0;
  const speechSynthesis = {
    speak: () => undefined,
    cancel: () => { cancelCalls++; }
  } as unknown as SpeechSynthesis;
  const player = createBrowserWakeAcknowledgementPlayer(
    speechSynthesis,
    () => ({ onend: null, onerror: null } as unknown as SpeechSynthesisUtterance),
    1
  );

  await player.play();

  assert.equal(cancelCalls, 1);
});

test("browser wake acknowledgement can cancel pending speech immediately", async () => {
  let cancelCalls = 0;
  const speechSynthesis = {
    speak: () => undefined,
    cancel: () => { cancelCalls++; }
  } as unknown as SpeechSynthesis;
  const player = createBrowserWakeAcknowledgementPlayer(
    speechSynthesis,
    () => ({ onend: null, onerror: null } as unknown as SpeechSynthesisUtterance),
    100
  );

  const playback = player.play();
  player.cancel?.();
  await playback;

  assert.equal(cancelCalls, 1);
});
