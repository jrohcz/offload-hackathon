# Real API fixtures

These files are captured from the Meta Model API during real-API verification.

`generated-used-turntable.webp` is a **generated test image** made by
`muse-image-1.0`. It is not a real seller listing or a photograph of a real
item. The clutter, wear, dust, and dust-cover crack are intentionally included
to exercise Offload's honesty and defect-handling paths.

JSON response fixtures contain sanitized response shapes and may omit binary
payloads, request identifiers, and other run-specific metadata.

Main review on 27 October regenerated `sell-flow-cutout.png` from the saved
live SAM stream after fixing the grayscale/RGB row-stride bug, then regenerated
`sell-flow-hero.png` with one live Muse Image edit from that corrected cutout.
Other saved responses remain earlier smoke-test evidence; they are not all a
single new end-to-end run. See `docs/QA-20261027.md` for hashes and limits.
