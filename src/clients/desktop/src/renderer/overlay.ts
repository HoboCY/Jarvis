declare global {
  interface Window {
    jarvisOverlay: {
      onNotification: (listener: (notification: { id: string; title: string; body: string }) => void) => () => void;
    };
  }
}

const title = document.getElementById("notification-title");
const body = document.getElementById("notification-body");
if (!title || !body) {
  throw new Error("The notification overlay root was not found.");
}

window.jarvisOverlay.onNotification(notification => {
  title.textContent = notification.title;
  body.textContent = notification.body;
});

export {};
