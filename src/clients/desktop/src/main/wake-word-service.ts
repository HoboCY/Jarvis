import { createRequire } from "node:module";
import { join } from "node:path";
import type {
  Device,
  Host,
  Stream as CpalStream,
  SupportedStreamConfig
} from "node-cpal";
import { wakeWordConfig } from "./wake-word-acceptance-config.js";

export const supportedWakeWord = wakeWordConfig.keyword;
export const supportedWakeWordTokens = wakeWordConfig.tokens;

const targetSampleRate = wakeWordConfig.samplingRate;
const maxBufferedAudioSeconds = 2;

type CpalRuntime = typeof import("node-cpal");

type SherpaStream = {
  acceptWaveform: (sampleRate: number, samples: Float32Array) => void;
  free: () => void;
};

type SherpaKeywordSpotter = {
  createStream: () => SherpaStream;
  decode: (stream: SherpaStream) => void;
  free: () => void;
  getResult: (stream: SherpaStream) => { keyword?: string };
  isReady: (stream: SherpaStream) => boolean;
  reset: (stream: SherpaStream) => void;
};

type SherpaRuntime = {
  createKws: (config: unknown) => SherpaKeywordSpotter;
};

type WakeWordRuntime = {
  cpal: CpalRuntime;
  sherpa: SherpaRuntime;
};

type AudioChunk = {
  channels: number;
  samples: Float32Array;
};

type ActiveWakeWordResources = {
  audioStream: CpalStream;
  device: Device;
  generation: number;
  host: Host;
  kws: SherpaKeywordSpotter;
  resampler: StreamingLinearResampler;
  stream: SherpaStream;
};

export type WakeWordServiceOptions = {
  modelRoot: string;
  onDetected: () => void;
  onError: (error: Error) => void;
};

const runtimeRequire = createRequire(import.meta.url);

function loadWakeWordRuntime(): WakeWordRuntime {
  return {
    cpal: runtimeRequire("node-cpal") as CpalRuntime,
    sherpa: runtimeRequire("sherpa-onnx") as SherpaRuntime
  };
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

const maxWakeWordErrorLength = 240;

export function sanitizeWakeWordError(reason: unknown): Error {
  const message = asError(reason).message
    .replace(/\bBearer\s+[^\s"'`]+/gi, "[REDACTED]")
    .replace(/\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*[^\s"'`,;]+/gi, "$1=[REDACTED]")
    .replace(/\bsecret\s+[^\s"'`,;]+/gi, "secret [REDACTED]")
    .replace(/\b(?:sk|ek|rk|sess)[-_][A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/(?:[A-Za-z]:)?\/(?:[^/\s'"`]+\/)+[^/\s'"`]*/g, "[REDACTED_PATH]")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxWakeWordErrorLength);
  return new Error(message || "Local wake-word detection failed.");
}

function isRecoverableInputStreamError(reason: unknown): boolean {
  return typeof reason === "object"
    && reason !== null
    && "code" in reason
    && reason.code === "XRUN";
}

function releaseAll(actions: Array<(() => void) | undefined>): unknown {
  let failure: unknown;
  for (const action of actions) {
    try {
      action?.();
    } catch (error) {
      failure ??= error;
    }
  }
  return failure;
}

function selectInputConfig(cpal: CpalRuntime, device: Device): SupportedStreamConfig<"f32"> {
  const defaultConfig = device.defaultInputConfig();
  if (defaultConfig.sampleFormat() === cpal.SampleFormat.F32) {
    return defaultConfig as SupportedStreamConfig<"f32">;
  }

  for (const range of device.supportedInputConfigs()) {
    if (range.sampleFormat() !== cpal.SampleFormat.F32) {
      continue;
    }

    return (range.tryWithSampleRate(targetSampleRate)
      ?? range.tryWithStandardSampleRate()
      ?? range.withMaxSampleRate()) as SupportedStreamConfig<"f32">;
  }

  throw new Error("The default microphone does not provide 32-bit floating-point audio.");
}

export function downmixToMono(samples: Float32Array, channels: number): Float32Array {
  if (!Number.isInteger(channels) || channels < 1) {
    throw new Error("Microphone channel count must be a positive integer.");
  }
  if (samples.length % channels !== 0) {
    throw new Error("Microphone audio does not contain complete channel frames.");
  }
  if (channels === 1) {
    return samples;
  }

  const mono = new Float32Array(samples.length / channels);
  for (let frame = 0; frame < mono.length; frame++) {
    let value = 0;
    for (let channel = 0; channel < channels; channel++) {
      value += samples[frame * channels + channel]!;
    }
    mono[frame] = value / channels;
  }
  return mono;
}

export class StreamingLinearResampler {
  private nextOutputPosition = 0;
  private previousSample: number | undefined;
  private totalInputFrames = 0;

  public constructor(
    private readonly inputSampleRate: number,
    private readonly outputSampleRate: number
  ) {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0
      || !Number.isFinite(outputSampleRate) || outputSampleRate <= 0) {
      throw new Error("Audio sample rates must be positive numbers.");
    }
  }

  public process(samples: Float32Array): Float32Array {
    if (samples.length === 0) {
      return samples;
    }
    if (this.inputSampleRate === this.outputSampleRate) {
      this.totalInputFrames += samples.length;
      this.previousSample = samples.at(-1);
      return samples;
    }

    const chunkStart = this.totalInputFrames;
    const chunkEnd = chunkStart + samples.length - 1;
    const step = this.inputSampleRate / this.outputSampleRate;
    const output: number[] = [];

    while (Math.ceil(this.nextOutputPosition) <= chunkEnd) {
      const firstIndex = Math.floor(this.nextOutputPosition);
      const secondIndex = Math.ceil(this.nextOutputPosition);
      const first = firstIndex < chunkStart
        ? this.previousSample
        : samples[firstIndex - chunkStart];
      const second = samples[secondIndex - chunkStart];
      if (first === undefined || second === undefined) {
        break;
      }

      const fraction = this.nextOutputPosition - firstIndex;
      output.push(first + (second - first) * fraction);
      this.nextOutputPosition += step;
    }

    this.totalInputFrames += samples.length;
    this.previousSample = samples.at(-1);
    return Float32Array.from(output);
  }

  public reset(): void {
    this.nextOutputPosition = 0;
    this.previousSample = undefined;
    this.totalInputFrames = 0;
  }
}

export class SherpaWakeWordService {
  private active: ActiveWakeWordResources | undefined;
  private generation = 0;
  private processingGeneration: number | undefined;
  private queuedSamples = 0;
  private readonly queue: AudioChunk[] = [];

  public constructor(
    private readonly options: WakeWordServiceOptions,
    private readonly loadRuntime: () => WakeWordRuntime = loadWakeWordRuntime
  ) {}

  public start(keyword: string): void {
    if (keyword !== supportedWakeWord) {
      throw new Error(`Unsupported wake word: ${keyword}`);
    }
    if (this.active) {
      return;
    }

    const generation = ++this.generation;
    let audioStream: CpalStream | undefined;
    let device: Device | undefined;
    let host: Host | undefined;
    let kws: SherpaKeywordSpotter | undefined;
    let stream: SherpaStream | undefined;
    try {
      const runtime = this.loadRuntime();
      kws = runtime.sherpa.createKws({
        featConfig: {
          samplingRate: wakeWordConfig.samplingRate,
          featureDim: wakeWordConfig.featureDim
        },
        modelConfig: {
          transducer: {
            encoder: join(this.options.modelRoot, "encoder.int8.onnx"),
            decoder: join(this.options.modelRoot, "decoder.int8.onnx"),
            joiner: join(this.options.modelRoot, "joiner.int8.onnx")
          },
          tokens: join(this.options.modelRoot, "tokens.txt"),
          numThreads: wakeWordConfig.numThreads,
          provider: wakeWordConfig.provider,
          debug: wakeWordConfig.debug,
          modelingUnit: wakeWordConfig.modelingUnit
        },
        maxActivePaths: wakeWordConfig.maxActivePaths,
        numTrailingBlanks: wakeWordConfig.numTrailingBlanks,
        keywordsScore: wakeWordConfig.keywordsScore,
        keywordsThreshold: wakeWordConfig.keywordsThreshold,
        keywords: wakeWordConfig.tokens
      });
      stream = kws.createStream();
      host = runtime.cpal.defaultHost();
      device = host.defaultInputDevice() ?? undefined;
      if (!device) {
        throw new Error("No default microphone is available for local wake-word detection.");
      }
      const supportedConfig = selectInputConfig(runtime.cpal, device);
      const inputConfig = supportedConfig.config();
      const resampler = new StreamingLinearResampler(inputConfig.sampleRate, targetSampleRate);
      audioStream = device.buildInputStream(
        inputConfig,
        runtime.cpal.SampleFormat.F32,
        data => this.enqueueAudio(new Float32Array(data), inputConfig.channels, inputConfig.sampleRate, generation),
        error => {
          // CPAL keeps the stream alive after a buffer overrun/underrun and delivers later audio normally.
          if (isRecoverableInputStreamError(error)) {
            return;
          }
          this.scheduleRuntimeFailure(asError(error), generation);
        });
      const resources: ActiveWakeWordResources = {
        audioStream,
        device,
        generation,
        host,
        kws,
        resampler,
        stream
      };
      this.active = resources;
      audioStream.play();
    } catch (error) {
      if (this.active?.generation === generation) {
        this.active = undefined;
      }
      this.generation++;
      this.queue.length = 0;
      this.queuedSamples = 0;
      this.processingGeneration = undefined;
      releaseAll([
        () => audioStream?.close(),
        () => stream?.free(),
        () => kws?.free(),
        () => device?.close(),
        () => host?.close()
      ]);
      throw sanitizeWakeWordError(error);
    }
  }

  public stop(): void {
    const active = this.active;
    this.active = undefined;
    this.generation++;
    this.queue.length = 0;
    this.queuedSamples = 0;
    this.processingGeneration = undefined;
    if (!active) {
      return;
    }

    const failure = releaseAll([
      () => active.audioStream.close(),
      () => active.stream.free(),
      () => active.kws.free(),
      () => active.device.close(),
      () => active.host.close()
    ]);
    if (failure) {
      throw sanitizeWakeWordError(failure);
    }
  }

  private enqueueAudio(
    samples: Float32Array,
    channels: number,
    inputSampleRate: number,
    generation: number
  ): void {
    const active = this.active;
    if (!active || active.generation !== generation) {
      return;
    }
    const maxSamples = inputSampleRate * channels * maxBufferedAudioSeconds;
    if (this.queuedSamples + samples.length > maxSamples) {
      return;
    }

    this.queue.push({ channels, samples });
    this.queuedSamples += samples.length;
    this.scheduleProcessing(generation);
  }

  private scheduleProcessing(generation: number): void {
    if (this.processingGeneration === generation) {
      return;
    }
    this.processingGeneration = generation;
    setImmediate(() => {
      if (this.processingGeneration === generation) {
        this.processingGeneration = undefined;
      }
      this.processNextChunk(generation);
    });
  }

  private processNextChunk(generation: number): void {
    const active = this.active;
    if (!active || active.generation !== generation) {
      return;
    }
    const chunk = this.queue.shift();
    if (!chunk) {
      return;
    }
    this.queuedSamples -= chunk.samples.length;

    try {
      const mono = downmixToMono(chunk.samples, chunk.channels);
      const resampled = active.resampler.process(mono);
      if (resampled.length > 0) {
        active.stream.acceptWaveform(targetSampleRate, resampled);
      }
      while (active.kws.isReady(active.stream)) {
        active.kws.decode(active.stream);
        const result = active.kws.getResult(active.stream);
        if (result.keyword === supportedWakeWord) {
          active.kws.reset(active.stream);
          active.resampler.reset();
          this.queue.length = 0;
          this.queuedSamples = 0;
          this.options.onDetected();
          break;
        }
      }
    } catch (error) {
      this.handleRuntimeFailure(asError(error), generation);
      return;
    }

    if (this.queue.length > 0) {
      this.scheduleProcessing(generation);
    }
  }

  private scheduleRuntimeFailure(error: Error, generation: number): void {
    setImmediate(() => this.handleRuntimeFailure(error, generation));
  }

  private handleRuntimeFailure(error: Error, generation: number): void {
    if (this.active?.generation !== generation) {
      return;
    }
    const safeError = sanitizeWakeWordError(error);
    try {
      this.stop();
      this.options.onError(safeError);
    } catch (cleanupError) {
      this.options.onError(new Error(
        `${safeError.message} Cleanup also failed: ${sanitizeWakeWordError(cleanupError).message}`
          .slice(0, maxWakeWordErrorLength)));
    }
  }
}
