module.exports = {
  packagerConfig: {
    asar: true,
    name: "Jarvis",
    executableName: "Jarvis",
    appBundleId: "com.hobocy.jarvis",
    osxArch: "arm64",
    osxMinimumSystemVersion: "13.0",
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
