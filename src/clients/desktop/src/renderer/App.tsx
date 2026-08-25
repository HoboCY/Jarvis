import { useEffect, useState } from "react";

export function App() {
  const [version, setVersion] = useState("loading");

  useEffect(() => {
    void window.jarvis.getAppVersion().then(setVersion);
  }, []);

  return (
    <main>
      <h1>Jarvis</h1>
      <p>Phase 0 desktop shell is ready.</p>
      <small>Desktop version: {version}</small>
    </main>
  );
}
