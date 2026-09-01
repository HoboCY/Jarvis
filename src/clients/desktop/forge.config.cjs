module.exports = {
  packagerConfig: {
    asar: {
      unpack: "**/*.node",
      unpackDir: "dist/assets/sherpa-kws-wenetspeech-3.3M"
    },
    name: "Jarvis",
    executableName: "Jarvis",
    appBundleId: "com.hobocy.jarvis",
    osxArch: "arm64",
    osxMinimumSystemVersion: "13.0",
    extendInfo: {
      NSMicrophoneUsageDescription: "Jarvis uses the microphone locally to detect the Chinese wake word 贾维斯."
    },
    ignore: [
      /^\/(?:node_modules|src|scripts)(?:\/|$)/,
      /^\/tsconfig(?:\..+)?$/,
      /^\/forge\.config\.cjs$/
    ],
    osxSign: process.env.JARVIS_MAC_SIGN_IDENTITY
      ? { identity: process.env.JARVIS_MAC_SIGN_IDENTITY }
      : undefined
  },
  rebuildConfig: {},
  makers: [
    { name: "@electron-forge/maker-zip", platforms: ["darwin"] }
  ]
};
