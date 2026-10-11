# Native diagnostics

The application sends best-effort fixed-category errors to the existing same-origin
`POST /api/telemetry` endpoint. It adds no analytics SDK. Reports contain only a
fixed error code/message, event UUID/time/count, Android platform, native binary Git
SHA and build version. Throwable messages, causes, stack frames, filenames, wallet
addresses, session cookies, request bodies and player text are excluded. The source
relay separately sanitizes native batches before both Sentry and PostHog.

A bounded encrypted no-backup journal retains the producing build across a restart.
A flush removes saved entries before sending, uses one-shot request bodies, no
cookies, no redirects and no connection/status retry, and has a finite deadline.
Failed delivery is dropped. Reports arriving during a flush remain for a later
lifecycle flush. Expected cancellation and ordinary payment/network refusal are
not reported as crashes. The previous Android crash handler still receives the
original exception. Offline preview builds do not initialize this transport.

Eleven focused privacy/transport/crash-handler tests and independent review pass.
The combined native1,917-test gate, lint, debug and unsigned release pass. Real
provider attribution and lifecycle delivery remain integration checks after the
reviewed source relay is deployed. 
