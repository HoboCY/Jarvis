# Offline wake-word acceptance fixtures

These are deterministic, non-user PCM inputs for the Desktop's local
sherpa-onnx acceptance command. The expected result for every fixture is
declared independently in `scripts/wake-word-acceptance.mjs`; the audio bytes
are never recorded from a user or sent over a network.

## Provenance and licence

- `jarvis-licensed-positive.wav` is a fixed `贾维斯` sample generated through
  the official [sherpa-onnx text-to-speech Space](https://huggingface.co/spaces/k2-fsa/text-to-speech)
  with model [`csukuangfj/vits-zh-aishell3`](https://huggingface.co/csukuangfj/vits-zh-aishell3),
  AISHELL-3 speaker ID `50`, speed
  `1.2`, and input text `贾维斯，贾维斯，贾维斯。`. The
  [AISHELL-3 data card](https://huggingface.co/datasets/AISHELL/AISHELL-3)
  declares Apache-2.0;
  that explicit upstream grant is the redistribution basis for this fixture.
  The generated output was converted with
  `afconvert -f WAVE -d LEI16@16000 -c 1` and is pinned as
  `bae8363b47875ca45ae620a1622c1df179ad03dd44582cd7070df30c025765bf`.
- Do not replace this asset with output from a local system voice: the macOS
  System Voice licence does not grant public redistribution.
- `silence`, `negative-synthetic`, and `background-synthetic` are generated
  in code by the acceptance command as 16 kHz mono signed-16-bit PCM. The
  latter two use fixed sine/noise seeds and contain no speech or user audio.
- The positive WAV is mono 16-bit PCM at 16 kHz, has a pinned SHA-256 in the
  manifest, and has the concrete source URL and grant recorded above. The
  runner checks the digest before using it, so an edited or substituted
  recording cannot silently become evidence.
- These fixtures are offline regression inputs, not user recordings, and are
  not a claim of human acoustic performance.

The acceptance boundary is intentionally explicit: an offline fixture is a
committed, hash-pinned input; synthetic speech made by a local TTS/system voice
is not redistributable evidence unless its licence says so; the packaged smoke
check runs the copied `dist` runtime and model; human microphone trials are a
separate, currently unperformed gate.

The model provenance and Apache-2.0 declaration are recorded in the adjacent
`sherpa-kws-wenetspeech-3.3M/MODEL_INFO.md` file. The fixtures contain no
credentials, identifiers, paths, or other user data.
