---
title: Interrupted requests no longer block your base
category: fixed
platforms: android
requires: none
---
If a reply is lost after you build, train, research, upgrade a hero or a wall, claim mail or buy an item, the Android app keeps the request, shows the server's own answer and reuses the same request on every retry, so the same order is never charged twice. Once the server confirms it has no record, or a day passes with no answer, CLOSE puts the request away and its button works again, and closed requests are checked again when you return so a late result still shows. A saved hero recruitment that is still being confirmed is no longer reported as missing.
