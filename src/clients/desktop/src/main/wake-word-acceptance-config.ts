export const wakeWordConfig = {
  keyword: "贾维斯",
  tokens: "j iǎ w éi s ī @贾维斯",
  samplingRate: 16_000,
  featureDim: 80,
  numThreads: 1,
  provider: "cpu",
  debug: 0,
  modelingUnit: "ppinyin",
  maxActivePaths: 4,
  numTrailingBlanks: 1,
  keywordsScore: 1.0,
  keywordsThreshold: 0.25
} as const;
