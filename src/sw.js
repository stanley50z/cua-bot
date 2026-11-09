// The web portal's service worker, served by src/web.ts at /sw.js and registered by app.html when the owner
// turns notifications on. It shows each Web Push from the bot (src/push.ts), with or without an open tab,
// and a click opens the chat of the bot that sent it, in the web portal's tab if one is open or else in a new one.
// A new version takes over at once, so a tab left open doesn't keep the old click behavior.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("push", (event) => {
  const message = event.data?.json() ?? {};
  const options = { body: message.body ?? "", data: { bot: message.bot } };
  if (message.tag) options.tag = message.tag;
  event.waitUntil(self.registration.showNotification(message.title || "cua-bot", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const bot = event.notification.data?.bot;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const app = tabs.find((tab) => new URL(tab.url).pathname === "/");
    if (!app) return self.clients.openWindow(bot === undefined ? "/" : `/#bot=${bot}`);
    if (bot !== undefined) app.postMessage({ bot });
    return app.focus();
  })());
});
