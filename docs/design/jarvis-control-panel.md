# Jarvis intelligent assistant control panel

This document records the image-first reference used for the Electron renderer redesign.

## Visual direction

- Quiet premium industrial-editorial desktop UI rather than an analytics dashboard.
- Three open zones: narrow navigation, primary conversation workspace, and action center.
- Warm graphite surfaces, bone text, chartreuse for healthy/active state, coral only for approvals and errors.
- One-pixel dividers and generous spacing replace nested cards; the message composer is the only persistently elevated surface.
- The 1280 x 900 first view keeps conversation primary while tasks and explicit approvals remain visible.

## Final image-generation prompt

```text
Use case: ui-mockup
Asset type: implementation-ready Electron desktop application UI reference, one complete 16:10 main window at 1440x960
Primary request: Design a premium intelligent assistant control panel called JARVIS. It is a real desktop workbench, not a marketing page and not a generic analytics dashboard. Show one clean complete application window.
Scene/backdrop: macOS Electron window with understated native traffic lights and a warm near-black graphite canvas. Very subtle tactile grain and faint technical rhythm lines, no obvious sci-fi wallpaper.
Subject: A personal AI assistant workspace with three open zones separated by precise hairline dividers: a narrow 72px left navigation rail, a spacious central conversation workspace, and a 320px right action rail. The center is the visual priority. At top center show a small greeting and a large concise Chinese headline: “晚上好，Hobo” and “有什么需要我处理？”. Beneath it, a restrained live assistant presence: a small luminous lime voice orb with a delicate horizontal waveform, labeled “等待‘贾维斯’唤醒”. Below that show a realistic conversation with only 3 messages, human text right aligned and assistant text left aligned, generous spacing, no bubble overload. Anchor a wide message composer at the bottom with exact placeholder “输入消息或按住说话…”, microphone button, and send arrow.
Left rail: minimalist JARVIS monogram near top; five simple line icons with Chinese labels “助手”, “会话”, “任务”, “审批”, “设置”; Assistant is active with a slim lime indicator, no rounded menu pills. A compact user avatar at bottom.
Right action rail: heading “行动中心”; an elegant unboxed list with “进行中的任务” and three realistic task rows using subtle progress treatment, one row expanded just enough to show a short result summary; a “待审批” row with a warm coral accent and two explicit buttons “仅批准本次” and “拒绝”; lower section “系统” showing Backend connected, Realtime ready, microphone standby as simple rows. At the top toolbar include a clear connected status and one notification bell.
Style/medium: high-fidelity polished product UI, quiet premium industrial-editorial design, Swiss rational hierarchy, refined grotesk typography, implementation clarity 10/10. Asymmetric editorial composition, open panes, precise alignment, flat hierarchy.
Composition/framing: front-on orthographic screenshot, full window visible, generous negative space, desktop UI sized realistically for a small laptop. Central column around 60%, right rail around 320px. Strong baseline grid. Do not show a device mockup around the window.
Lighting/mood: calm, focused, trustworthy, capable, low-light without feeling cyberpunk.
Color palette: graphite #11130F, charcoal #191C17, warm bone #F1EEE5, muted stone #9B9F94, electric chartreuse #C7EE63 only for active/healthy states, warm coral #F07A5A only for pending approval. No purple or blue gradients.
Materials/textures: matte surfaces, one-pixel warm-gray dividers, minimal soft shadows only for the composer and active overlay.
Typography: large greeting 42–48px, section headings 18–22px, body 14–16px, clean readable Chinese UI text. Use sentence case, avoid excessive uppercase.
Signature components: product UI panel stack; off-grid editorial layout; pristine gapless bento rhythm; vertical rhythm lines.
Motion-implied cues: staggered float-up energy in message appearance; smooth accordion expansion energy in task detail.
Constraints: retain real product capabilities only: conversation, voice/realtime state, tasks, approval, notification, diagnostics; accessible contrast; visually buildable with React and CSS; no nested cards; no giant rounded outer container; no tiny decorative metadata; no charts; no tables; no fake system jargon; no stock photography; no character illustration; no text too small to inspect.
Avoid: generic SaaS dashboard, card grid spam, glassmorphism, glowing blue sci-fi HUD, purple gradients, excessive pills, excessive border radius, floating blobs, fake analytics, clutter, illegible text, repeated boxed panels, watermark.
```

The reference was generated with Codex's built-in image generation tool and then translated into React and CSS without using the bitmap in the runtime UI.
