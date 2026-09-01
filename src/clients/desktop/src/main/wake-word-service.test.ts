import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SherpaWakeWordService,
  StreamingLinearResampler,
  downmixToMono,
  supportedWakeWord,
  supportedWakeWordTokens
} from "./wake-word-service.js";

function fakeRuntime(options: { failOnPlay?: boolean } = {}) {
  const lifecycle: string[] = [];
  const sampleFormat = {};
  let dataCallback: ((samples: Float32Array) => void) | undefined;
  let errorCallback: ((error: unknown) => void) | undefined;
  let ready = false;
  const stream = {
    acceptWaveform: (_sampleRate: number, samples: Float32Array) => {
      lifecycle.push("accept");
      ready = (samples[0] ?? 0) > 0.5;
    },
    free: () => lifecycle.push("stream:free")
  };
  const kws = {
    createStream: () => stream,
    decode: () => {
      lifecycle.push("decode");
      ready = false;
    },
    free: () => lifecycle.push("kws:free"),
    getResult: () => ({ keyword: supportedWakeWord }),
    isReady: () => ready,
    reset: () => lifecycle.push("reset")
  };
  const audioStream = {
    close: () => lifecycle.push("audio:close"),
    play: () => {
      lifecycle.push("audio:play");
      if (options.failOnPlay) {
        dataCallback?.(Float32Array.of(0.9));
        throw new Error("microphone play failed");
      }
    }
  };
  const device = {
    buildInputStream: (
      _config: unknown,
      _format: unknown,
      onData: (samples: Float32Array) => void,
      onError: (error: unknown) => void
    ) => {
      dataCallback = onData;
      errorCallback = onError;
      return audioStream;
    },
    close: () => lifecycle.push("device:close"),
    defaultInputConfig: () => ({
      config: () => ({ channels: 1, sampleRate: 16_000 }),
      sampleFormat: () => sampleFormat
    }),
    supportedInputConfigs: () => []
  };
  const host = {
    close: () => lifecycle.push("host:close"),
    defaultInputDevice: () => device
  };
  return {
    emit: (samples: Float32Array) => dataCallback?.(samples),
    fail: (error: unknown) => errorCallback?.(error),
    lifecycle,
    runtime: {
      cpal: {
        defaultHost: () => host,
        SampleFormat: { F32: sampleFormat }
      },
      sherpa: { createKws: () => kws }
    }
  };
}

test("Chinese Jarvis uses partial-pinyin tokens supported by the WenetSpeech model", () => {
  assert.equal(supportedWakeWord, "贾维斯");
  assert.equal(supportedWakeWordTokens, "j iǎ w éi s ī @贾维斯");
});

test("downmixToMono averages complete interleaved microphone frames", () => {
  assert.deepEqual(
    downmixToMono(Float32Array.from([1, -1, 0.5, 0.25]), 2),
    Float32Array.from([0, 0.375]));
  assert.throws(
    () => downmixToMono(Float32Array.from([1, 2, 3]), 2),
    /complete channel frames/);
});

test("StreamingLinearResampler preserves phase across microphone chunks", () => {
  const resampler = new StreamingLinearResampler(48_000, 16_000);

  const first = resampler.process(Float32Array.from([0, 1, 2, 3, 4]));
  const second = resampler.process(Float32Array.from([5, 6, 7, 8, 9]));

  assert.deepEqual(first, Float32Array.from([0, 3]));
  assert.deepEqual(second, Float32Array.from([6, 9]));
});

test("SherpaWakeWordService detects locally and releases every native resource", async () => {
  const fake = fakeRuntime();
  let detections = 0;
  const service = new SherpaWakeWordService({
    modelRoot: "/models",
    onDetected: () => detections++,
    onError: error => assert.fail(error.message)
  }, () => fake.runtime as never);

  service.start(supportedWakeWord);
  fake.emit(Float32Array.of(0.9));
  await new Promise<void>(resolve => setImmediate(resolve));
  service.stop();

  assert.equal(detections, 1);
  assert.deepEqual(fake.lifecycle, [
    "audio:play",
    "accept",
    "decode",
    "reset",
    "audio:close",
    "stream:free",
    "kws:free",
    "device:close",
    "host:close"
  ]);
});

test("SherpaWakeWordService clears failed-start audio before a clean restart", async () => {
  const failed = fakeRuntime({ failOnPlay: true });
  const restarted = fakeRuntime();
  const runtimes = [failed.runtime, restarted.runtime];
  let detections = 0;
  const service = new SherpaWakeWordService({
    modelRoot: "/models",
    onDetected: () => detections++,
    onError: error => assert.fail(error.message)
  }, () => runtimes.shift() as never);

  assert.throws(() => service.start(supportedWakeWord), /microphone play failed/);
  service.start(supportedWakeWord);
  restarted.emit(Float32Array.of(0.1));
  await new Promise<void>(resolve => setImmediate(resolve));
  service.stop();

  assert.equal(detections, 0);
  assert.deepEqual(failed.lifecycle.slice(-5), [
    "audio:close",
    "stream:free",
    "kws:free",
    "device:close",
    "host:close"
  ]);
});

test("SherpaWakeWordService continues after a recoverable microphone xrun", async () => {
  const fake = fakeRuntime();
  let detections = 0;
  const service = new SherpaWakeWordService({
    modelRoot: "/models",
    onDetected: () => detections++,
    onError: error => assert.fail(error.message)
  }, () => fake.runtime as never);

  service.start(supportedWakeWord);
  fake.fail(Object.assign(new Error("A buffer underrun or overrun occurred."), { code: "XRUN" }));
  fake.emit(Float32Array.of(0.9));
  await new Promise<void>(resolve => setImmediate(resolve));
  service.stop();

  assert.equal(detections, 1);
});

test("SherpaWakeWordService stops after a non-recoverable microphone error", async () => {
  const fake = fakeRuntime();
  let reportedError: Error | undefined;
  const service = new SherpaWakeWordService({
    modelRoot: "/models",
    onDetected: () => assert.fail("audio received after a fatal microphone error"),
    onError: error => {
      reportedError = error;
    }
  }, () => fake.runtime as never);

  service.start(supportedWakeWord);
  fake.fail(Object.assign(new Error("The microphone was disconnected."), {
    code: "DEVICE_NOT_AVAILABLE"
  }));
  await new Promise<void>(resolve => setImmediate(resolve));
  fake.emit(Float32Array.of(0.9));
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.equal(reportedError?.message, "The microphone was disconnected.");
  assert.deepEqual(fake.lifecycle.slice(-5), [
    "audio:close",
    "stream:free",
    "kws:free",
    "device:close",
    "host:close"
  ]);
});
