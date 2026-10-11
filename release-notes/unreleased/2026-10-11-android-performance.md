---
title: A faster start and a smoother Home on phones
category: improved
platforms: android
requires: none
---
Your base is now the first thing the app asks the server for at start, so it no longer waits behind other requests, and a brief network hiccup on that request is retried at once. Reopening Home reuses the scene it already prepared, building art loads faster before the scene appears, and sheets draw their artwork on their very first frame. Realm decorations and the HUD do less work on every frame, and a base update that fails keeps the current picture and tries once more.
