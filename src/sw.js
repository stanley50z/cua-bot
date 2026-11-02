// The web app's service worker, served by src/web.ts at /sw.js and registered by app.html when the owner
// turns notifications on. It shows each Web Push from the bot (src/push.ts), with or without an open tab,
// and a click focuses the app's tab or opens a new one.
self.addEventListener("push", (event) => {
  const message = event.data?.json() ?? {};
  const options = { body: message.body ?? "" };
  if (message.tag) options.tag = message.tag;
  event.waitUntil(self.registration.showNotification(message.title || "cua-bot", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const app = tabs.find((tab) => new URL(tab.url).pathname === "/");
    return app ? app.focus() : self.clients.openWindow("/");
  })());
});
