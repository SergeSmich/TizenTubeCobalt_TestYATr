import pathlib

d = next(pathlib.Path('apk_out').rglob('libchrobalt.so')).read_bytes()

# кандидаты на "жертву" — длинные бесполезные в проде домены
cands = [
    b"autopush-realtimemediaservices-pa.sandbox.googleapis.com",
    b"embeddedassistant-frontend-webchannel.googleapis.com",
    b"youtubei-googleapis-staging.sandbox.google.com",
    b"content-googleapis-staging.sandbox.google.com",
    b"staging-userpaneltv-pa.sandbox.googleapis.com",
    b"staging-oauthdelegation-pa.googleapis.com",
    b"nightwatchregistration-pa.googleapis.com",
    b"embeddedassistant-webchannel.googleapis.com",
    b"www-googleapis-staging.sandbox.google.com",
    b"staging-daily-www.sandbox.googleapis.com",
    b"staging-www.sandbox.googleapis.com",
    b"debugsettings-pa.googleapis.com",
    b"cert-test.sandbox.google.com",
]

WORKER = b"vot-worker.kload.workers.dev"
print("worker host length:", len(WORKER))
print()
found = []
for c in cands:
    i = d.find(c)
    print(len(c), "OK " if i >= 0 else "-- ", i, c.decode())
    if i >= 0 and len(c) >= len(WORKER):
        found.append((c, i))

print()
if found:
    c, i = found[0]
    print("=== FIRST USABLE SLOT ===")
    print("domain :", c.decode())
    print("length :", len(c), "(>= 28, влезает)")
    print("offset :", i)
    print("context:", repr(d[i-60:i+len(c)+60]))
else:
    print("Нет длинного домена в бинаре — нужен другой подход.")